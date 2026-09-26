import { Injectable, Logger } from "@nestjs/common";
import { WebhookEventService } from "../webhook-event/webhook-event.service";
import { SENDGRID_EVENT_STATUS_MAP } from "src/common/constants/sendgrid-event-mapping.constant";
import { shouldUpdateStatus } from "src/common/utils/email-priority.util";
import { PrismaService } from "src/prisma/prisma.service";
import { EmailStatusGateway } from "../email-status-gateway/email-status.gateway";

// Bounce status codes that trigger unsubscribe on a Manual-flow row , or a
// daily retry instead on an AI sequence row - see recordWebhookEvent()'s
// isAiSequenceRow branch.
const UNSUBSCRIBE_BOUNCE_STATUSES = ["5.1.3", "5.1.1", "5.2.1"];

// How long to wait before each resend of an AI sequence email that bounced.
const AI_SEQUENCE_BOUNCE_RETRY_DAYS = 1;

// How many resends an AI sequence email gets after its first bounce - one a
// day, so a row that bounces today is retried tomorrow and the day after,
// then unsubscribed if the last retry bounces too.
const AI_SEQUENCE_BOUNCE_MAX_RETRIES = 2;

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly webhookEventService: WebhookEventService,
    private readonly prisma: PrismaService,
    private readonly emailStatusGateway: EmailStatusGateway,
  ) {}

  async processEvents(events: any[]) {
    this.logger.log(JSON.stringify(events, null, 2));

    for (const event of events) {
      let autoId = this.parseAutoId(event);

      if (!autoId) {
        autoId = await this.resolveAutoIdByMessageId(event?.sg_message_id);
      }

      const sgEventId = String(event?.sg_event_id ?? "").trim();

      // Store every webhook event in webhook_events - guarded by sg_event_id
      // so a retried delivery of the SAME SendGrid event (SendGrid resends
      // if our endpoint is slow, or if one event in an earlier batch threw)
      // gets caught here and skipped entirely, instead of double-counting
      // opens/duplicating status updates below.
      const inserted = await this.webhookEventService.create({
        userEmailId: autoId || null,
        eventType: event.event,
        eventTimestamp: new Date(event.timestamp * 1000),
        webhookPayload: event,
        guid: sgEventId || undefined,
      });

      if (!inserted) {
        this.logger.warn(
          `Duplicate webhook delivery skipped | sg_event_id=${sgEventId} | event=${event.event} | auto_id=${autoId}`,
        );
        continue;
      }

      const retryQueued = await this.recordWebhookEvent(event, autoId);

      /**
       * Update user_emails.email_status only if higher priority. Skipped when
       * a bounce was just re-queued for a retry: PHP only re-picks a row whose
       * email_status is NULL, so writing BOUNCED here would strand it.
       */
      const incomingStatus = SENDGRID_EVENT_STATUS_MAP[event.event];
      if (autoId && incomingStatus && !retryQueued) {
        const current = await this.prisma.userEmail.findUnique({
          where: { autoId },
          select: {
            emailStatus: true,
            tempGroupId: true,
            groupExcelid: true,
            isSend: true,
            unsubscribe: true,
          },
        });

        if (
          current &&
          shouldUpdateStatus(current.emailStatus, incomingStatus)
        ) {
          const updated = await this.prisma.userEmail.update({
            where: { autoId },
            data: { emailStatus: incomingStatus },
          });
          this.logger.log(
            `Email auto_id=${autoId} status: ${current.emailStatus} -> ${incomingStatus}`,
          );

          this.emailStatusGateway.notifyRowChanged({
            autoId,
            tempGroupId: updated.tempGroupId,
            groupExcelid: updated.groupExcelid,
            emailStatus: updated.emailStatus,
            previousEmailStatus: current.emailStatus,
            emailCount: updated.emailCount,
            errordetails: updated.errordetails,
            isSend: updated.isSend,
            unsubscribe: updated.unsubscribe,
          });
        }
      }
    }

    return { received: true, count: events.length };
  }

  // auto_id is a custom arg, so it arrives as a string when present and is
  // absent entirely on events SendGrid strips custom args from. 0 means
  // "no user_emails row to attribute this to".
  private parseAutoId(event: any): number {
    const raw = event?.auto_id ?? event?.custom_args?.auto_id;

    if (raw === undefined || raw === null || raw === "") {
      return 0;
    }

    const parsed = parseInt(String(raw), 10);

    return Number.isNaN(parsed) ? 0 : parsed;
  }

  // sg_message_id is the send-time id with a suffix appended, either
  // "<id>.recvd-..." or "<id>.filter...". PHP's webhook split it the same way
  // before matching it against user_emails.sendGridId.
  private baseMessageId(sgMessageId: unknown): string {
    return String(sgMessageId ?? "")
      .split(".recvd-")[0]
      .split(".filter")[0];
  }

  private async resolveAutoIdByMessageId(
    sgMessageId: unknown,
  ): Promise<number> {
    const messageId = this.baseMessageId(sgMessageId);

    if (!messageId) {
      return 0;
    }

    const row = await this.prisma.userEmail.findFirst({
      where: { sendGridId: messageId },
      orderBy: { autoId: "desc" },
      select: { autoId: true },
    });

    return row?.autoId ?? 0;
  }

  // Events that mean the mail did not reach the recipient. "deferred" is left
  // out - SendGrid retries those on its own.
  private readonly failureEvents = new Set([
    "bounce",
    "blocked",
    "dropped",
    "spamreport",
  ]);

  // Returns true when a bounce re-queued the row for a retry, so
  // processEvents() leaves email_status alone - see
  // retryBouncedAiSequenceEmail().
  private async recordWebhookEvent(
    event: any,
    autoId: number,
  ): Promise<boolean> {
    const eventName: string = event.event || "";
    const email: string = event.email || "";

    let isAiSequenceRow = false;
    let retryQueued = false;
    let target: {
      autoId: number;
      tempGroupId: number;
      groupExcelid: number;
      isSend: number;
      unsubscribe: number;
    } | null = null;

    if (autoId) {

       target = await this.prisma.userEmail.findUnique({
        where: { autoId },
        select: {
          autoId: true,
          tempGroupId: true,
          groupExcelid: true,
          isSend: true,
          unsubscribe: true,
        },
      });

      console.log(target);

      if (!target) {
        this.logger.warn(
          `Skipping ${eventName} for auto_id=${autoId} - no user_emails row`,
        );

        return false;
      }

      const templateGroup = await this.prisma.templateGroup.findUnique({
        where: { id: target.tempGroupId },
        select: { isAi: true },
      });
      isAiSequenceRow = templateGroup?.isAi === 1;
    }

    // The raw event itself is already persisted unconditionally in
    // processEvents() via webhookEventService.create() (webhook_events table).
    // With no auto_id there is no user_emails row for the rest of this
    // function to update.
    if (!autoId) {
      this.logger.warn(
        `Webhook event received without auto_id | event=${eventName} | email=${email}`,
      );

      return false;
    }

    try {
      // open event: increment open count. email_status itself is now set
      // below by the unified EmailStatus-priority path (OPENED), not here.
      // errordetails is left untouched - it now only ever carries a failure
      // reason (see failureEvents below), so a successful open must never
      // write into it.
      if (eventName === "open") {
        const updated = await this.prisma.userEmail.update({
          where: { autoId },
          data: {
            emailCount: { increment: 1 },
          },
        });

        await this.checkHighViewCountAlert(autoId);

        if (target) {
          this.emailStatusGateway.notifyRowChanged({
            autoId,
            tempGroupId: target.tempGroupId,
            groupExcelid: target.groupExcelid,
            emailStatus: updated.emailStatus,
            emailCount: updated.emailCount,
            errordetails: updated.errordetails,
            isSend: target.isSend,
            unsubscribe: target.unsubscribe,
          });
        }
      }

      // Why it didn't arrive, kept on the row. errordetails was left empty on
      // every failure, so the UI could say a send hadn't landed but never why -
      // a Gmail block for domain reputation looked the same as a row still
      // waiting its turn. Truncated because the column is varchar(255).
      if (this.failureEvents.has(eventName)) {
        const reason = String(
          event.reason || event.response || event.status || "",
        )
          .replace(/\s+/g, " ")
          .trim();

        const updated = await this.prisma.userEmail.update({
          where: { autoId },
          data: {
            errordetails: reason.slice(0, 255),
          },
        });

        if (target) {
          this.emailStatusGateway.notifyRowChanged({
            autoId,
            tempGroupId: target.tempGroupId,
            groupExcelid: target.groupExcelid,
            emailStatus: updated.emailStatus,
            emailCount: updated.emailCount,
            errordetails: updated.errordetails,
            isSend: target.isSend,
            unsubscribe: target.unsubscribe,
          });
        }
      }

      const bounceStatus: string = event.status || "";
      const bounceType: string = event.type || "";
      const isRetryableBounce =
        eventName === "bounce" &&
        (UNSUBSCRIBE_BOUNCE_STATUSES.includes(bounceStatus) ||
          bounceType === "blocked");

      const isOptOut =
        eventName === "unsubscribe" || eventName === "spamreport";

      if (isAiSequenceRow) {
        if (isRetryableBounce) {
          const retry = await this.retryBouncedAiSequenceEmail(autoId);
          if (retry === "exhausted") {
            await this.unsubscribeRow(autoId);
          }
          retryQueued = retry === "queued";
        } else if (isOptOut || eventName === "bounce") {
          await this.unsubscribeRow(autoId);
        }
      } else if (isOptOut || isRetryableBounce) {
        await this.unsubscribeRow(autoId);
      }

      this.logger.log(
        `user_emails updated | auto_id=${autoId} | event=${eventName}`,
      );
    } catch (err) {
      this.logger.error(
        `user_emails update failed | auto_id=${autoId} | ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return retryQueued;
  }

  // Moves the triggering row into unsubscribe_user_email, then sweeps every
  // OTHER still-pending row in the same recipient's sequence too (their
  // queued follow-up steps AND the initial email if that's not the row that
  // triggered this - same user_email/tempGroupId/groupExcelid, isSend=0) -
  // a webhook unsubscribe event, whether it fired off the initial email or
  // a later follow-up, always stops the whole sequence for that recipient.
  // Already-sent rows are never swept - they're delivery history, not
  // something to cancel.
  private async unsubscribeRow(autoId: number) {
    const source = await this.moveRowToUnsubscribeList(autoId);

    if (!source) {
      return null;
    }

    const pendingSiblings = await this.prisma.userEmail.findMany({
      where: {
        userEmail: source.userEmail,
        tempGroupId: source.tempGroupId,
        groupExcelid: source.groupExcelid,
        isSend: 0,
      },
    });

    for (const sibling of pendingSiblings) {
      await this.moveRowToUnsubscribeList(sibling.autoId);
    }

    return source;
  }

  // Moves one user_emails row into unsubscribe_user_email and permanently
  // deletes it from user_emails - no FK references user_emails.auto_id, so
  // this is a plain delete, not a soft-delete flag. A webhook retry
  // (SendGrid redelivery, or unsubscribe firing alongside a bounce on the
  // same row) must not create a second mirror row for the same recipient,
  // so this is a no-op once already mirrored; also a no-op if the row is
  // already gone (a prior call already moved it).
  private async moveRowToUnsubscribeList(autoId: number) {
    const alreadyMirrored = await this.prisma.unsubscribeUserEmail.findFirst({
      where: { userEmailId: autoId },
    });

    if (alreadyMirrored) {
      return null;
    }

    const source = await this.prisma.userEmail.findUnique({
      where: { autoId },
    });

    if (!source) {
      return null;
    }

    await this.prisma.unsubscribeUserEmail.create({
      data: {
        userEmailId: source.autoId,
        parentId: source.parentId,
        adminId: source.adminId,
        userEmail: source.userEmail,
        userName: source.userName,
        userSubject: source.userSubject,
        userDesc: source.userDesc,
        userToken: source.userToken,
        emailCount: source.emailCount,
        emailStatus: source.emailStatus ?? "no",
        isDeleted: 0,
        potentialLeads: 0,
        unsubscribe: 1,
        errordetails: source.errordetails,
        isSend: source.isSend,
        tempGroupId: source.tempGroupId,
        groupExcelid: source.groupExcelid,
        templateTblId: source.templateTblId,
        followType: source.followType,
        followSteps: source.followSteps,
        sendGridId: source.sendGridId ?? "",
      },
    });

    await this.prisma.userEmail.delete({ where: { autoId: source.autoId } });

    return source;
  }

  // Re-queues the same AI sequence email that soft-bounced, on the same row,
  // AI_SEQUENCE_BOUNCE_RETRY_DAYS out. AI sequence rows (main and every
  // follow step) are all created up front by PHP's queueInitialEmailCron and
  // picked up again by rows with is_send=0 AND email_status IS NULL AND a due
  // follow_date - retryStaleInitialEmails() for 'main', queueFollowupEmailCron()
  // for 'follow' - so resetting those three is what gets it resent. The main
  // row going back to is_send=0 also holds its follow steps, since
  // queueFollowupEmailCron() only sends a step whose parent has is_send=1.
  // sendGridId is cleared because SendgridService only claims rows where it
  // is null. errordetails keeps the bounce reason until the resend.
  //
  // "exhausted" once the row has used up AI_SEQUENCE_BOUNCE_MAX_RETRIES, so the
  // caller unsubscribes it instead.
  private async retryBouncedAiSequenceEmail(
    autoId: number,
  ): Promise<"queued" | "exhausted" | "missing"> {
    const source = await this.prisma.userEmail.findUnique({
      where: { autoId },
      select: { autoId: true },
    });

    if (!source) {
      return "missing";
    }

    // Every bounce on this row is already in webhook_events (processEvents
    // stores it, deduped by sg_event_id, before calling in here), so the count
    // includes the current one: the first bounce plus one per failed retry.
    const bounces = await this.prisma.webhookEvent.count({
      where: { userEmailId: autoId, eventType: "bounce" },
    });

    if (bounces > AI_SEQUENCE_BOUNCE_MAX_RETRIES) {
      this.logger.log(
        `retryBouncedAiSequenceEmail: auto_id=${autoId} bounced ${bounces} times - retries used up, unsubscribing`,
      );
      return "exhausted";
    }

    const retryDate = new Date();
    retryDate.setDate(retryDate.getDate() + AI_SEQUENCE_BOUNCE_RETRY_DAYS);

    const updated = await this.prisma.userEmail.update({
      where: { autoId },
      data: {
        isSend: 0,
        emailStatus: null,
        followDate: retryDate,
        sendGridId: null,
        sentDate: null,
      },
    });

    this.emailStatusGateway.notifyRowChanged({
      autoId,
      tempGroupId: updated.tempGroupId,
      groupExcelid: updated.groupExcelid,
      emailStatus: updated.emailStatus,
      emailCount: updated.emailCount,
      errordetails: updated.errordetails,
      isSend: updated.isSend,
      unsubscribe: updated.unsubscribe,
    });

    this.logger.log(
      `retryBouncedAiSequenceEmail: queued retry ${bounces}/${AI_SEQUENCE_BOUNCE_MAX_RETRIES} for auto_id=${autoId} at ${retryDate.toISOString()}`,
    );

    return "queued";
  }

  private async checkHighViewCountAlert(autoId: number) {
    const row = await this.prisma.userEmail.findUnique({
      where: { autoId },
      select: { emailCount: true, userEmail: true, viewAlertSent: true },
    });

    if (!row || row.emailCount < 5 || row.viewAlertSent === 1) {
      return;
    }

    const logRows = await this.prisma.webhookEvent.findMany({
      where: { userEmailId: autoId, eventType: "open" },
      orderBy: { eventTimestamp: "asc" },
      select: { eventTimestamp: true },
    });

    let spacedGaps = 0;
    for (let i = 1; i < logRows.length; i++) {
      const gapSeconds =
        (logRows[i].eventTimestamp.getTime() -
          logRows[i - 1].eventTimestamp.getTime()) /
        1000;
      if (gapSeconds > 60) {
        spacedGaps++;
      }
    }

    if (spacedGaps < 2) {
      return;
    }

    const webhookSetting = await this.prisma.setting.findUnique({
      where: { key: "slack_webhook_url" },
    });
    const webhookUrl = webhookSetting?.value?.trim();
    if (!webhookUrl) {
      return;
    }

    const message = `*High Email Engagement Alert*\nRecipient: *${row.userEmail}*\nOpened ${row.emailCount} times, with genuinely spaced-out repeat opens.\nThis lead looks highly engaged - worth a follow-up.`;

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: message }),
      });

      // fetch only throws on a transport error. A revoked webhook or a deleted
      // channel answers with a 404/403 body, which would otherwise pass for sent.
      if (!response.ok) {
        throw new Error(
          `Slack returned ${response.status} ${await response.text()}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Slack alert failed | auto_id=${autoId} | ${err instanceof Error ? err.message : String(err)}`,
      );

      // Leave view_alert_sent as it is so a later open tries again. The flag is
      // one-shot, so setting it after a failed post would drop this recipient's
      // alert for good.
      return;
    }

    await this.prisma.userEmail.update({
      where: { autoId },
      data: { viewAlertSent: 1 },
    });
  }
}
