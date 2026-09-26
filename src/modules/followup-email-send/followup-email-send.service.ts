import { Injectable, Logger } from "@nestjs/common";
// import { Cron, CronExpression } from "@nestjs/schedule"; // disabled temporarily
import { randomBytes } from "crypto";
import { PrismaService } from "src/prisma/prisma.service";
import { RabbitmqPublisherService } from "src/common/rabbitmq/rabbitmq-publisher.service";
import {
  addCalendarDays,
  zonedAt,
  zonedNow,
} from "src/common/time/zoned-time.util";
import { incrementSettingCounter } from "src/common/utils/atomic-counter.util";

interface FollowupParent {
  autoId: number;
  userEmail: string;
  userName: string;
  userSubject: string;
  userDesc: string;
  userCreatedate: Date;
  followDate: Date;
  followSteps: number;
  tempGroupId: number;
  groupExcelid: number;
  smtpSettingId: number | null;
}

interface StepTemplate {
  tempId: number;
  groupId: number;
  groupStep: number;
  groupDays: string;
  groupSignatureId: number;
  tempSubject: string;
  tempDesc: string;
}

@Injectable()
export class FollowupEmailSendService {
  private readonly logger = new Logger(FollowupEmailSendService.name);

  private readonly batchLimit = 50;

  private readonly candidateFetchLimit = 2000;

  // Follow-ups go out from 09:00 in the sequence's own timezone - the same hour
  // NewEmailSendService opens a sequence's day at, and the hour the PHP
  // CronController::sendGroupEmail() used. It checked for hour === 9 exactly,
  // which lost a whole day if the process was down over that hour; from-09:00
  // is safe here because each step is deduped below.
  private readonly sendWindowStartHour = 9;

  // Guard against an overlapping run (cron tick firing while a manual/HTTP
  // trigger, or a slow previous tick, is still dispatching) sending a step
  // twice before its follow-up row exists.
  private isDispatching = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbitmqPublisher: RabbitmqPublisherService,
  ) {}

  // @Cron(CronExpression.EVERY_MINUTE) // disabled temporarily
  async dispatchPendingFollowupEmails() {
    if (this.isDispatching) {
      this.logger.warn(
        "dispatchPendingFollowupEmails: previous run still in progress, skipping this tick",
      );
      return { dispatched: 0, total: 0 };
    }
    this.isDispatching = true;
    try {
      return await this.runDispatch();
    } finally {
      this.isDispatching = false;
    }
  }

  // Admin-configured daily cap (tracking_project's "FollowUp Email Sending
  // Limit" page writes settings.followup_daily_email_limit). Tracked via a
  // per-day settings counter rather than a DB column - same dedupe-by-key
  // pattern NewEmailSendService.checkEmailShortage uses.
  private async getRemainingDailyBudget(): Promise<number> {
    const dailyLimitSetting = await this.prisma.setting.findUnique({
      where: { key: "followup_daily_email_limit" },
    });
    const dailyLimit = dailyLimitSetting?.value
      ? parseInt(dailyLimitSetting.value, 10)
      : 600;

    const sentCounterSetting = await this.prisma.setting.findUnique({
      where: { key: this.todaySentCounterKey() },
    });
    const sentToday = sentCounterSetting?.value
      ? parseInt(sentCounterSetting.value, 10)
      : 0;

    return dailyLimit - sentToday;
  }

  private async incrementDailySentCount(count: number): Promise<void> {
    if (count <= 0) {
      return;
    }
    // isDispatching only rules out a second run on THIS instance - a second
    // app instance ticking the same minute would still race a plain
    // read-then-write on this key, so this goes through MySQL's own atomic
    // upsert-increment instead.
    await incrementSettingCounter(
      this.prisma,
      this.todaySentCounterKey(),
      count,
    );
  }

  private todaySentCounterKey(): string {
    return `followup_sent_count_${new Date().toISOString().slice(0, 10)}`;
  }

  // Port of CronController::sendGroupEmail(). It decides whose next step is due
  // today and sends it; the PHP version handed off through the follow_data
  // queue, which nothing on either side ever drained.
  //
  // This is NOT allowed to send follow_type='main' rows - those are first-time
  // emails owned by NewEmailSendService. An earlier version of this service did
  // exactly that, so no follow-up was ever sent while first emails leaked past
  // each sequence's email_limit_per_day.
  private async runDispatch() {
    const remainingToday = await this.getRemainingDailyBudget();
    if (remainingToday <= 0) {
      this.logger.log("runDispatch: daily follow-up limit reached, skipping");
      return { dispatched: 0, total: 0 };
    }

    // is_send = 1 matters: a follow-up has to follow an email that actually
    // went out. The PHP query left this condition off, so a contact whose first
    // email was still queued behind the daily limit could be followed up first.
    const parents = await this.prisma.userEmail.findMany({
      where: { followType: "main", isSend: 1, isDeleted: 0, unsubscribe: 0 },
      orderBy: { autoId: "asc" },
      take: this.candidateFetchLimit,
      select: {
        autoId: true,
        userEmail: true,
        userName: true,
        userSubject: true,
        userDesc: true,
        userCreatedate: true,
        followDate: true,
        followSteps: true,
        tempGroupId: true,
        groupExcelid: true,
        smtpSettingId: true,
      },
    });

    if (parents.length === 0) {
      this.logger.log("runDispatch: no sent emails to follow up on");
      return { dispatched: 0, total: 0 };
    }

    const groups = await this.prisma.templateGroup.findMany({
      where: {
        id: { in: [...new Set(parents.map((parent) => parent.tempGroupId))] },
        archive: 0,
        isDelete: "0",
      },
      select: { id: true, timezone: true, settingsId: true },
    });

    // Only sequences that have reached 09:00 in their own timezone.
    const openGroups = new Map<
      number,
      { settingsId: number; timeZone: string }
    >();
    for (const group of groups) {
      const clock = zonedNow(group.timezone);
      if (clock.fellBack) {
        this.logger.warn(
          `runDispatch: sequence ${group.id} has an unusable timezone "${group.timezone}"`,
        );
      }
      if (clock.hour >= this.sendWindowStartHour) {
        openGroups.set(group.id, {
          settingsId: group.settingsId,
          timeZone: group.timezone,
        });
      }
    }

    if (openGroups.size === 0) {
      this.logger.log(
        `runDispatch: no sequence has reached its ${this.sendWindowStartHour}:00 send window yet`,
      );
      return { dispatched: 0, total: 0 };
    }

    const templates = await this.prisma.template.findMany({
      where: { groupId: { in: [...openGroups.keys()] }, isDelete: "0" },
      select: {
        tempId: true,
        groupId: true,
        groupStep: true,
        groupDays: true,
        groupSignatureId: true,
        tempSubject: true,
        tempDesc: true,
      },
    });
    const templateByStep = new Map(
      templates.map((template) => [
        `${template.groupId}:${template.groupStep}`,
        template,
      ]),
    );

    // Signatures are optional here. The PHP query INNER JOINed group_signature,
    // so a template pointing at a signature row that no longer exists silently
    // dropped every follow-up for that sequence.
    const signatures = await this.prisma.groupSignature.findMany({
      where: {
        signatureId: {
          in: [
            ...new Set(templates.map((template) => template.groupSignatureId)),
          ],
        },
        isDeleted: "0",
      },
      select: { signatureId: true, signatureBody: true },
    });
    const signatureById = new Map(
      signatures.map((signature) => [
        signature.signatureId,
        signature.signatureBody,
      ]),
    );

    const due: {
      parent: FollowupParent;
      template: StepTemplate;
      step: number;
    }[] = [];

    for (const parent of parents) {
      const group = openGroups.get(parent.tempGroupId);
      if (!group) {
        continue;
      }

      const step = parent.followSteps + 1;
      const template = templateByStep.get(`${parent.tempGroupId}:${step}`);
      if (!template) {
        // No template for the next step - this contact is through the sequence.
        continue;
      }

      const groupDays = parseInt(template.groupDays, 10);
      if (Number.isNaN(groupDays)) {
        continue;
      }

      // Due today, or on any day already gone by. Matching today exactly would
      // lose a step for good whenever its day passed unsent - the process being
      // down over it, or the daily cap running out - because follow_date and
      // follow_steps only move once the step is actually sent, so a due date
      // left behind can never come round again and the contact stops dead.
      // Overdue steps are picked up on the next run instead, and follow_date is
      // stamped with the send, so the rest of the sequence chains off the catch
      // up rather than firing every missed step at once.
      if (
        this.dueDate(
          parent.followDate,
          groupDays,
          group.timeZone,
          step,
        ) > zonedNow(group.timeZone).date
      ) {
        continue;
      }

      due.push({ parent, template, step });
    }

    if (due.length === 0) {
      this.logger.log("runDispatch: no follow-up step falls due today");
      return { dispatched: 0, total: 0 };
    }

    // One query instead of one per contact: which of these steps already went
    // out. Replaces the PHP follow_data lookup - user_emails is the record of
    // what was sent, so it can't drift out of sync with a separate queue table.
    const alreadySent = await this.prisma.userEmail.findMany({
      where: {
        followType: "follow",
        parentId: { in: due.map((item) => item.parent.autoId) },
      },
      select: { parentId: true, followSteps: true },
    });
    const sentSteps = new Set(
      alreadySent.map((row) => `${row.parentId}:${row.followSteps}`),
    );

    const pending = due
      .filter((item) => !sentSteps.has(`${item.parent.autoId}:${item.step}`))
      .slice(0, Math.min(this.batchLimit, remainingToday));

    if (pending.length === 0) {
      this.logger.log("runDispatch: today's due follow-ups have all been sent");
      return { dispatched: 0, total: 0 };
    }

    let dispatched = 0;

    for (const { parent, template, step } of pending) {
      const group = openGroups.get(parent.tempGroupId);
      if (!group) {
        continue;
      }

      try {
        const body = await this.buildBody(
          parent,
          template,
          signatureById.get(template.groupSignatureId) ?? "",
        );

        // The follow-up MUST use the domain stored on its Initial Email, never
        // whatever this sequence's active rotation week happens to be right
        // now - that's the whole point of storing it there in the first
        // place. The sequence's legacy fixed settings_id is only a fallback
        // for a parent row created before that column existed; if neither is
        // set, sendRawEmail falls back to the rotating sender pool itself.
        const domainId =
          parent.smtpSettingId ?? (group.settingsId || undefined);

        // Claim the step on the parent and create the follow-up row in one
        // transaction. Checking `alreadySent` and then create()-ing lets two
        // overlapping runs (a slow tick plus the next one, or a second app
        // instance) both pass that check for the same parent+step and both
        // send the follow-up. The claim is the atomic part: this UPDATE's
        // WHERE clause only matches while the parent is still sitting at the
        // followSteps value read above, so a second caller racing the same
        // step affects 0 rows and backs off before creating a row or
        // publishing anything.
        const claimed = await this.prisma.$transaction(async (tx) => {
          const claim = await tx.userEmail.updateMany({
            where: { autoId: parent.autoId, followSteps: parent.followSteps },
            data: { followSteps: step },
          });

          if (claim.count === 0) {
            return null;
          }

          // The follow-up's own row has to exist before the send: sendRawEmail
          // stamps sent_emails.requestPayload with this auto_id and the SendGrid
          // webhook maps opens and clicks back through it. Created unsent, flipped
          // to sent once the publish goes through.
          return tx.userEmail.create({
            data: {
              parentId: parent.autoId,
              userEmail: parent.userEmail,
              userName: parent.userName,
              userSubject: template.tempSubject,
              userDesc: body,
              userToken: randomBytes(16).toString("hex"),
              isDeleted: 0,
              tempGroupId: parent.tempGroupId,
              excelId: 0,
              groupExcelid: parent.groupExcelid,
              templateTblId: template.tempId,
              followType: "follow",
              followSteps: step,
              followDate: new Date(),
              isSend: 0,
              errordetails: "",
              senderIp: "",
              smtpSettingId: domainId,
            },
            select: { autoId: true },
          });
        });

        if (!claimed) {
          this.logger.log(
            `runDispatch: step ${step} for auto_id=${parent.autoId} already claimed by another run - skipping`,
          );
          continue;
        }

        const created = claimed;

        try {
          await this.rabbitmqPublisher.publishSendEmail({
            auto_id: created.autoId,
            recipientEmail: parent.userEmail,
            subject: template.tempSubject,
            htmlContent: body,
            settingsId: domainId,
          });
        } catch (publishError) {
          await this.prisma
            .$transaction(async (tx) => {
              await tx.userEmail.delete({ where: { autoId: created.autoId } });
              await tx.userEmail.updateMany({
                where: { autoId: parent.autoId, followSteps: step },
                data: { followSteps: parent.followSteps },
              });
            })
            .catch((rollbackError) => {
              this.logger.error(
                `runDispatch: failed to roll back claimed step ${step} after publish failure | follow_up auto_id=${created.autoId} | parent auto_id=${parent.autoId} | ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
              );
            });

          throw publishError;
        }

        dispatched++;

        const settle = async (what: string, run: () => Promise<unknown>) => {
          try {
            await run();
          } catch (error) {
            this.logger.error(
              `runDispatch: ${what} failed after step ${step} was queued | follow_up auto_id=${created.autoId} | parent auto_id=${parent.autoId} | ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        };

        await settle("marking the follow-up sent", () =>
          this.prisma.userEmail.update({
            where: { autoId: created.autoId },
            data: { isSend: 1 },
          }),
        );

        await settle("recording the sequence's sender", () =>
          this.prisma.groupSmtp.create({
            data: { groupId: parent.tempGroupId, smptId: domainId ?? 0 },
          }),
        );

        await settle("stamping the parent's follow_date", () =>
          this.prisma.userEmail.update({
            where: { autoId: parent.autoId },
            data: { followDate: new Date() },
          }),
        );
      } catch (error) {
        this.logger.error(
          `runDispatch: follow-up step ${step} failed before send | auto_id=${parent.autoId} | ${parent.userEmail} | ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await this.incrementDailySentCount(dispatched);

    this.logger.log(
      `runDispatch: dispatched ${dispatched}/${pending.length} follow-up emails`,
    );

    return { dispatched, total: pending.length };
  }

 
  private static readonly MIN_WORKING_DAYS_TO_FIRST_FOLLOWUP = 4;

  private dueDate(
    followDate: Date,
    groupDays: number,
    timeZone: string,
    step: number,
  ): string {
    const effectiveWorkingDays =
      step === 1
        ? Math.max(
            groupDays,
            FollowupEmailSendService.MIN_WORKING_DAYS_TO_FIRST_FOLLOWUP,
          )
        : groupDays;

    return addCalendarDays(
      zonedAt(followDate, timeZone).date,
      effectiveWorkingDays,
    );
  }

  // Greeting + this step's template + signature + the previous email quoted
  // underneath, the same shape sendGroupEmail() built.
  private async buildBody(
    parent: FollowupParent,
    template: StepTemplate,
    signatureBody: string,
  ): Promise<string> {
    const previous = await this.prisma.userEmail.findFirst({
      where: { parentId: parent.autoId },
      orderBy: { autoId: "desc" },
      select: { userSubject: true, userDesc: true, userCreatedate: true },
    });

    const quoted = previous ?? {
      userSubject: parent.userSubject,
      userDesc: parent.userDesc,
      userCreatedate: parent.userCreatedate,
    };

    const quotedDesc = quoted.userDesc.replace(/<img[^>]+>/gi, "");
    const header =
      `<strong>Date:</strong> ${this.formatQuotedDate(quoted.userCreatedate)} (UTC)<br>` +
      `<strong>To:</strong> ${parent.userName}, ${parent.userEmail}<br>` +
      `<strong>Subject:</strong> ${quoted.userSubject}<br>` +
      `---------------------------------------<br><br>`;

    return (
      `Hi ${parent.userName},${template.tempDesc}<br><br>${signatureBody}` +
      `<br><br><div style='margin-left:4%;'><hr>${header}${quotedDesc}</div>`
    );
  }

  private formatQuotedDate(date: Date): string {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    }).formatToParts(date);

    const valueOf = (type: string) =>
      parts.find((part) => part.type === type)?.value ?? "";

    const day = parseInt(valueOf("day"), 10);
    const suffix =
      day % 10 === 1 && day !== 11
        ? "st"
        : day % 10 === 2 && day !== 12
          ? "nd"
          : day % 10 === 3 && day !== 13
            ? "rd"
            : "th";

    return (
      `${valueOf("weekday")} ${day}${suffix} of ${valueOf("month")} ` +
      `${valueOf("year")} ${valueOf("hour")}:${valueOf("minute")}:${valueOf("second")} ` +
      `${valueOf("dayPeriod").toUpperCase()}`
    );
  }
}
