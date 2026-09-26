import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
// import { Cron, CronExpression } from "@nestjs/schedule"; // disabled temporarily
import { randomBytes } from "crypto";
import { PrismaService } from "src/prisma/prisma.service";
import { RabbitmqPublisherService } from "src/common/rabbitmq/rabbitmq-publisher.service";
import { AiRewriteService } from "../ai-rewrite/ai-rewrite.service";
import { DomainRotationService } from "../domain-rotation/domain-rotation.service";
import {
  DEFAULT_TIME_ZONE,
  zonedNow,
  weekdayOf,
} from "src/common/time/zoned-time.util";
import { MoveExcelTempResult } from "./types/pending-excel-data.type";
import { incrementSettingCounter } from "src/common/utils/atomic-counter.util";

@Injectable()
export class NewEmailSendService {
  private readonly logger = new Logger(NewEmailSendService.name);

  private readonly batchLimit = 50;

  private readonly userFetchLimit = 2000;

  private readonly sendWindowStartHour = 9;

  private readonly sendWindowEndHour = 11;

  // migratePendingExcelData can take well over a minute (AI rewrite delay
  // per row), so @Cron(EVERY_MINUTE) would otherwise overlap with itself -
  // guard against a run starting while the previous one is still going.
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly rabbitmqPublisher: RabbitmqPublisherService,
    private readonly aiRewriteService: AiRewriteService,
    private readonly domainRotationService: DomainRotationService,
  ) {}

  // @Cron(CronExpression.EVERY_MINUTE) // disabled temporarily
  async runNewEmailSendCron() {
    if (this.isRunning) {
      this.logger.warn(
        "runNewEmailSendCron: previous run still in progress, skipping this tick",
      );
      return null;
    }

    this.isRunning = true;
    try {
      const moved = await this.moveExcelTempToMain();
      const migrated = await this.migratePendingExcelData();
      const dispatched = await this.dispatchPendingEmails();
      await this.checkEmailShortage();
      return { moved, migrated, dispatched };
    } finally {
      this.isRunning = false;
    }
  }

  // Fires the actual emails - each sequence sends from its own fixed domain
  // (template_grouptbl.settings_id), not a shared round-robin pool. Runs
  // after migratePendingExcelData so freshly-migrated rows go out the same
  // tick, and before checkEmailShortage so alerts reflect the post-send count.
  async dispatchPendingEmails() {
    const userEmails = await this.prisma.userEmail.findMany({
      where: { followType: "main", isSend: 0, unsubscribe: 0 },
      orderBy: { autoId: "asc" },
      take: this.userFetchLimit,
      select: {
        autoId: true,
        userEmail: true,
        userSubject: true,
        userDesc: true,
        followDate: true,
        groupExcelid: true,
        tempGroupId: true,
        smtpSettingId: true,
      },
    });

    if (userEmails.length === 0) {
      this.logger.log("dispatchPendingEmails: No pending excel emails found");
      return { dispatched: 0, total: 0 };
    }

    const groupExcelIds = [
      ...new Set(userEmails.map((userEmail) => userEmail.groupExcelid)),
    ];
    const groupExcels = await this.prisma.groupExcel.findMany({
      where: { groupExcelid: { in: groupExcelIds } },
      select: { groupExcelid: true, excelTime: true },
    });
    const excelMinutesByGroupExcelId = new Map(
      groupExcels.map((groupExcel) => [
        groupExcel.groupExcelid,
        parseInt(groupExcel.excelTime, 10) || 0,
      ]),
    );

    const tempGroupIds = [
      ...new Set(userEmails.map((userEmail) => userEmail.tempGroupId)),
    ];
    const templateGroups = await this.prisma.templateGroup.findMany({
      where: { id: { in: tempGroupIds } },
      select: {
        id: true,
        settingsId: true,
        emailLimitPerDay: true,
        timezone: true,
        isAi: true,
      },
    });
    const settingsIdByGroupId = new Map(
      templateGroups.map((templateGroup) => [
        templateGroup.id,
        templateGroup.settingsId,
      ]),
    );
    const timeZoneByGroupId = new Map(
      templateGroups.map((templateGroup) => [
        templateGroup.id,
        templateGroup.timezone,
      ]),
    );

    // email_limit_per_day is an allowance for the whole day, not for this
    // tick - what the sequence already sent today has to come off it first.
    const remainingByGroupId = await this.remainingDailyQuota(templateGroups);

    // Below-limit stock means the sequence can't fill a full day - hold every
    // send for it, not just the sends over quota, until it's topped back up
    // to email_limit_per_day. checkEmailShortage alerts on this same
    // condition; this is what actually stops the emails.
    const lowStockGroupIds = await this.lowStockGroupIds(templateGroups);
    for (const groupId of lowStockGroupIds) {
      remainingByGroupId.set(groupId, 0);
    }

    const now = Date.now();
    const dueUserEmails = userEmails
      .filter((userEmail) => {
        if (!settingsIdByGroupId.has(userEmail.tempGroupId)) {
          return false;
        }
        const excelMinutes = excelMinutesByGroupExcelId.get(
          userEmail.groupExcelid,
        );
        if (excelMinutes === undefined) {
          return false;
        }
        return userEmail.followDate.getTime() + excelMinutes * 60_000 <= now;
      })
      // Drop what's over each sequence's remaining allowance before the
      // batchLimit slice, so a capped sequence can't use up the slots the
      // sequences that still have allowance left need.
      .filter((userEmail) => {
        const remaining = remainingByGroupId.get(userEmail.tempGroupId) ?? 0;
        if (remaining <= 0) {
          return false;
        }
        remainingByGroupId.set(userEmail.tempGroupId, remaining - 1);
        return true;
      })
      .slice(0, this.batchLimit);

    if (dueUserEmails.length === 0) {
      this.logger.log("dispatchPendingEmails: No pending excel emails found");
      return { dispatched: 0, total: 0 };
    }

    let dispatched = 0;
    const dispatchedByGroupId = new Map<number, number>();

    for (const userEmail of dueUserEmails) {
      try {
        const claim = await this.prisma.userEmail.updateMany({
          where: { autoId: userEmail.autoId, isSend: 0 },
          data: { isSend: 2 },
        });

        if (claim.count === 0) {
          this.logger.log(
            `dispatchPendingEmails: auto_id=${userEmail.autoId} already claimed by another run - skipping`,
          );
          continue;
        }

        try {
          const settingsId =
            userEmail.smtpSettingId ??
            settingsIdByGroupId.get(userEmail.tempGroupId);

          await this.rabbitmqPublisher.publishSendEmail({
            auto_id: userEmail.autoId,
            recipientEmail: userEmail.userEmail,
            subject: userEmail.userSubject,
            htmlContent: userEmail.userDesc,
            settingsId,
          });
        } catch (publishError) {
          await this.prisma.userEmail
            .update({
              where: { autoId: userEmail.autoId },
              data: { isSend: 0 },
            })
            .catch((revertError) => {
              this.logger.error(
                `dispatchPendingEmails: failed to release claim for auto_id=${userEmail.autoId} after publish failure | ${revertError instanceof Error ? revertError.message : String(revertError)}`,
              );
            });
          throw publishError;
        }

        await this.prisma.userEmail.update({
          where: { autoId: userEmail.autoId },
          data: { isSend: 1 },
        });

        dispatched++;
        dispatchedByGroupId.set(
          userEmail.tempGroupId,
          (dispatchedByGroupId.get(userEmail.tempGroupId) ?? 0) + 1,
        );
      } catch (error) {
        this.logger.error(
          `dispatchPendingEmails: Failed to dispatch auto_id=${userEmail.autoId} | ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await this.incrementDailySentCount(dispatchedByGroupId, timeZoneByGroupId);

    this.logger.log(
      `dispatchPendingEmails: Dispatched ${dispatched}/${dueUserEmails.length} excel emails`,
    );

    return { dispatched, total: dueUserEmails.length };
  }

  // One counter per sequence per day, the day being the sequence's own
  // timezone's day - the same clock its 09:00 window is measured on. So the
  // allowance resets at that timezone's midnight and becomes usable at 09:00,
  // and a sequence can never send more than its limit in one of its own days.
  private sentCounterKey(groupId: number, zonedDate: string): string {
    return `new_email_sent_count_${groupId}_${zonedDate}`;
  }

  // How many new emails each sequence may send right now: nothing at all
  // before 09:00 in its own timezone, otherwise its allowance minus what it
  // has already sent during that timezone's day.
  private async remainingDailyQuota(
    templateGroups: {
      id: number;
      emailLimitPerDay: number;
      timezone: string;
      isAi: number;
    }[],
  ): Promise<Map<number, number>> {
    const remainingByGroupId = new Map<number, number>();

    for (const group of templateGroups) {
      const { date, hour } = zonedNow(group.timezone);

      if (hour < this.sendWindowStartHour) {
        this.logger.log(
          `remainingDailyQuota: sequence ${group.id} is at ${hour}:00 ${group.timezone}, before its ${this.sendWindowStartHour}:00 send window - holding`,
        );
        remainingByGroupId.set(group.id, 0);
        continue;
      }

      if (group.isAi === 1) {
        const weekday = weekdayOf(date);
        const isWeekend = weekday === 0 || weekday === 6;

        if (hour >= this.sendWindowEndHour || isWeekend) {
          this.logger.log(
            `remainingDailyQuota: AI sequence ${group.id} is at ${hour}:00 ${group.timezone} (weekday=${weekday}), outside its ${this.sendWindowStartHour}:00-${this.sendWindowEndHour}:00 weekday window - holding`,
          );
          remainingByGroupId.set(group.id, 0);
          continue;
        }
      }

      const counter = await this.prisma.setting.findUnique({
        where: { key: this.sentCounterKey(group.id, date) },
      });
      const sentToday = counter?.value ? parseInt(counter.value, 10) : 0;

      remainingByGroupId.set(group.id, group.emailLimitPerDay - sentToday);
    }

    return remainingByGroupId;
  }

  private async getGlobalDailyLimit(): Promise<number> {
    const globalDailyLimitSetting = await this.prisma.setting.findUnique({
      where: { key: "daily_email_limit" },
    });
    return globalDailyLimitSetting?.value
      ? parseInt(globalDailyLimitSetting.value, 10)
      : 600;
  }

  // Stock is what's ready to send (user_emails) plus what's still upstream
  // (excel_upload_temp, excel_data_upload) - an upload only becomes a
  // user_emails row once migration gets to it, a few seconds later.
  private async groupStock(
    groupId: number,
    emailLimitPerDay: number,
    globalDailyLimit: number,
  ): Promise<{ dailyLimit: number; pendingCount: number; stock: number }> {
    const dailyLimit = emailLimitPerDay || globalDailyLimit;

    const [pendingRows, tempBacklog, uploadBacklog] = await Promise.all([
      this.prisma.userEmail.findMany({
        where: {
          tempGroupId: groupId,
          followType: "main",
          isSend: 0,
          isDeleted: 0,
          potentialLeads: 0,
          unsubscribe: 0,
        },
        distinct: ["userEmail"],
        select: { userEmail: true },
      }),
      this.prisma.excelUploadTemp.count({ where: { groupId } }),
      this.prisma.excelDataUpload.count({ where: { groupId } }),
    ]);
    // Ready count is unique recipients, not raw rows - a sheet re-uploaded
    // before moveExcelTempToMain drains it can otherwise leave several
    // duplicate user_emails rows per address (see moveExcelTempToMain's
    // within-batch dedup) and inflate this past the real number of people
    // left to email.
    const pendingCount = pendingRows.length;

    return {
      dailyLimit,
      pendingCount,
      stock: pendingCount + tempBacklog + uploadBacklog,
    };
  }

  // Groups whose stock has dropped below their own email_limit_per_day (or
  // the global fallback) - sending holds for these until stock is topped
  // back up, same condition checkEmailShortage alerts on.
  private async lowStockGroupIds(
    templateGroups: { id: number; emailLimitPerDay: number }[],
  ): Promise<Set<number>> {
    const globalDailyLimit = await this.getGlobalDailyLimit();
    const blocked = new Set<number>();

    for (const group of templateGroups) {
      const { dailyLimit, stock } = await this.groupStock(
        group.id,
        group.emailLimitPerDay,
        globalDailyLimit,
      );
      if (stock < dailyLimit) {
        blocked.add(group.id);
      }
    }

    return blocked;
  }

  private async incrementDailySentCount(
    dispatchedByGroupId: Map<number, number>,
    timeZoneByGroupId: Map<number, string>,
  ): Promise<void> {
    for (const [groupId, count] of dispatchedByGroupId) {
      if (count <= 0) {
        continue;
      }

      const timeZone = timeZoneByGroupId.get(groupId) ?? DEFAULT_TIME_ZONE;
      const key = this.sentCounterKey(groupId, zonedNow(timeZone).date);
      // isRunning only rules out a second run on THIS instance - a second app
      // instance ticking the same minute would still race a plain
      // read-then-write on this key, so this goes through MySQL's own atomic
      // upsert-increment instead.
      await incrementSettingCounter(this.prisma, key, count);
    }
  }

  async moveExcelTempToMain(): Promise<MoveExcelTempResult | null> {
    const batch = await this.prisma.excelUploadTemp.findFirst({
      orderBy: { id: "asc" },
      select: { groupId: true, excelName: true, excelTime: true },
    });
    if (!batch) {
      this.logger.log(
        "moveExcelTempToMain: No pending uploads in excel_upload_temp",
      );
      return null;
    }

    const { groupId, excelName, excelTime } = batch;

    // Per-sequence limit set on the group takes priority; fall back to the
    // global settings.daily_email_limit only if the group's own value isn't
    // usable (e.g. group got deleted between upload and this run).
    const templateGroup = await this.prisma.templateGroup.findUnique({
      where: { id: groupId },
      select: { emailLimitPerDay: true, timezone: true },
    });
    let pickLimit = templateGroup?.emailLimitPerDay;
    if (!pickLimit) {
      const dailyLimitSetting = await this.prisma.setting.findUnique({
        where: { key: "daily_email_limit" },
      });
      pickLimit = dailyLimitSetting?.value
        ? parseInt(dailyLimitSetting.value, 10)
        : 600;
    }

    // The date this pick belongs to, on the sequence's own clock - the same one
    // its send window and daily counter are measured on.
    const pickDate = zonedNow(
      templateGroup?.timezone || DEFAULT_TIME_ZONE,
    ).date;

    // pickLimit is a day's worth, not a per-run allowance - and this cron runs
    // every minute. So a pick is capped by what the sequence has already used of
    // today: emails it has sent, plus what is queued up to send (staged in
    // excel_data_upload, or migrated into user_emails and not sent yet).
    //
    // Counting only the queue was not enough. Once a day's emails had gone out
    // the queue was empty again, so the next tick a minute later happily picked
    // another day's worth: group 1's sheet produced 2026-08-18_Aug2026_4 at
    // 11:34 and 2026-08-18_Aug2026_3 at 11:35, and the second batch's contacts
    // then sat unsent with the day's allowance already spent.
    const [sentCounter, stagedCount, unsentCount] = await Promise.all([
      this.prisma.setting.findUnique({
        where: { key: this.sentCounterKey(groupId, pickDate) },
      }),
      this.prisma.excelDataUpload.count({ where: { groupId } }),
      this.prisma.userEmail.count({
        where: {
          tempGroupId: groupId,
          followType: "main",
          isSend: 0,
          isDeleted: 0,
        },
      }),
    ]);

    const sentToday = sentCounter?.value ? parseInt(sentCounter.value, 10) : 0;
    const waiting = stagedCount + unsentCount;
    const capacity = pickLimit - sentToday - waiting;

    if (capacity <= 0) {
      this.logger.log(
        `moveExcelTempToMain: sequence ${groupId} has used its ${pickLimit} for ${pickDate} (${sentToday} sent, ${waiting} queued) - leaving the rest in excel_upload_temp`,
      );
      return null;
    }

    const tempRows = await this.prisma.excelUploadTemp.findMany({
      where: { groupId, excelName },
      orderBy: { id: "asc" },
      take: capacity,
      select: { id: true, name: true, email: true },
    });

    if (tempRows.length === 0) {
      return null;
    }

    const allEmails = [
      ...new Set(tempRows.map((tempRow) => tempRow.email.toLowerCase())),
    ];

    // Dedup against user_emails and excel_data_upload (email column is
    // globally unique there; both columns use case-insensitive collations,
    // so a plain `in` match already behaves case-insensitively).
    const existingUserEmails = new Set<string>();
    const existingExcelEmails = new Set<string>();
    for (let i = 0; i < allEmails.length; i += 500) {
      const chunk = allEmails.slice(i, i + 500);

      const userRows = await this.prisma.userEmail.findMany({
        where: { parentId: 0, userEmail: { in: chunk } },
        select: { userEmail: true },
      });
      userRows.forEach((userRow) =>
        existingUserEmails.add(userRow.userEmail.toLowerCase()),
      );

      const excelRows = await this.prisma.excelDataUpload.findMany({
        where: { email: { in: chunk } },
        select: { email: true },
      });
      excelRows.forEach((excelRow) =>
        existingExcelEmails.add(excelRow.email.toLowerCase()),
      );
    }

    const pickedCount = tempRows.length;
    // <pick date>_<sheet name>_<how many this pick took>, so every day's pick is
    // its own group_excel row and reads back as what it was. The date comes off
    // the sequence's own timezone - the same clock its send window is measured
    // on - not the server's.
    //
    // This only reads as one row per day because the capacity check above holds
    // the pick to a day's worth. Before that check the cron picked every minute,
    // so a sheet produced several rows with an identical date and count inside a
    // few minutes and looked duplicated.
    const batchName = `${pickDate}_${excelName}_${pickedCount}`;

    const insertBatch: { name: string; email: string }[] = [];
    const duplicateBatch: { email: string }[] = [];
    const processedIds = tempRows.map((tempRow) => tempRow.id);

    // Repeat uploads of the same sheet before this batch's rows are consumed
    // land in tempRows together, so dedup against what's already been picked
    // into insertBatch here too - not just against rows committed before this
    // run started.
    const insertedThisBatch = new Set<string>();
    for (const tempRow of tempRows) {
      const email = tempRow.email;
      const emailLower = email.toLowerCase();
      if (
        existingUserEmails.has(emailLower) ||
        insertedThisBatch.has(emailLower)
      ) {
        duplicateBatch.push({ email });
      } else if (!existingExcelEmails.has(emailLower)) {
        insertBatch.push({ name: tempRow.name, email });
        insertedThisBatch.add(emailLower);
      }
    }

    // group_excel header row + the two batch inserts + the temp cleanup all
    // reference the group_excel id, so keep them on one connection via a
    // transaction.
    await this.prisma.$transaction(async (tx) => {
      const groupExcel = await tx.groupExcel.create({
        data: {
          excelName: batchName,
          excelTime,
          groupId,
          isDeleted: "0",
        },
      });

      if (insertBatch.length > 0) {
        await tx.excelDataUpload.createMany({
          data: insertBatch.map((insertRow) => ({
            name: insertRow.name,
            email: insertRow.email,
            groupExcelId: groupExcel.groupExcelid,
            groupId,
            reason: "",
          })),
        });
      }

      if (duplicateBatch.length > 0) {
        await tx.duplicateEmailRecord.createMany({
          data: duplicateBatch.map((duplicateRow) => ({
            email: duplicateRow.email,
            excelsheetName: batchName,
            groupExcelId: groupExcel.groupExcelid,
            groupId,
          })),
        });
      }

      await tx.excelUploadTemp.deleteMany({
        where: { id: { in: processedIds } },
      });
    });

    this.logger.log(
      `moveExcelTempToMain: batch=${batchName} picked=${pickedCount} inserted=${insertBatch.length} duplicates=${duplicateBatch.length}`,
    );

    return {
      picked: pickedCount,
      inserted: insertBatch.length,
      duplicates: duplicateBatch.length,
    };
  }

  async migratePendingExcelData() {
    const excelDataUploadRows = await this.prisma.excelDataUpload.findMany({
      where: { status: 0, isLock: 0 },
      orderBy: { id: "asc" },
      take: this.batchLimit,
    });

    if (excelDataUploadRows.length === 0) {
      this.logger.log("No pending excel_data_upload rows found");
      return { migrated: 0, total: 0 };
    }

    const excelDataUploadIds = excelDataUploadRows.map(
      (excelDataUploadRow) => excelDataUploadRow.id,
    );
    await this.prisma.excelDataUpload.updateMany({
      where: { id: { in: excelDataUploadIds } },
      data: { isLock: 1 },
    });

    let migrated = 0;
    // The resolved domain for a groupId only depends on that group's own
    // config and the current week - both fixed for the life of this run - so
    // caching it here means a batch of rows sharing a groupId (the common
    // case, since one excel upload targets one group) resolves it once
    // instead of once per row.
    const smtpSettingIdByGroupId = new Map<number, number | undefined>();

    for (const excelDataUploadRow of excelDataUploadRows) {
      try {
        const templateGroup = await this.prisma.templateGroup.findFirst({
          where: { id: excelDataUploadRow.groupId, archive: 0 },
        });

        const template = templateGroup
          ? await this.prisma.template.findFirst({
              where: { groupId: excelDataUploadRow.groupId, isDelete: "0" },
              orderBy: { tempId: "asc" },
            })
          : null;

        if (!template) {
          this.logger.error(
            `No template found for group_id=${excelDataUploadRow.groupId} | excel_data_upload.id=${excelDataUploadRow.id} | unlocking for retry`,
          );
          await this.prisma.excelDataUpload.update({
            where: { id: excelDataUploadRow.id },
            data: { isLock: 0 },
          });
          continue;
        }

        let smtpSettingId: number | undefined;
        if (smtpSettingIdByGroupId.has(excelDataUploadRow.groupId)) {
          smtpSettingId = smtpSettingIdByGroupId.get(
            excelDataUploadRow.groupId,
          );
        } else {
          // No configured rotation pool for this sequence yet is an expected,
          // ongoing rollout state, not a failure - DomainRotationService
          // returns null for it, and this falls back to the sequence's
          // legacy fixed domain (or to sendRawEmail's own round-robin
          // fallback if that isn't set either) exactly like a row created
          // before this feature existed does.
          const domain =
            await this.domainRotationService.getActiveDomainForWorkingWeek(
              excelDataUploadRow.groupId,
            );
          smtpSettingId =
            domain?.id ?? (templateGroup?.settingsId || undefined);
          smtpSettingIdByGroupId.set(excelDataUploadRow.groupId, smtpSettingId);
        }

        const signature = await this.prisma.groupSignature.findUnique({
          where: { signatureId: template.groupSignatureId },
        });

        const rewritten = await this.rewriteContent(
          template.tempSubject,
          template.tempDesc,
          template.aiPrompt ?? undefined,
        );
        const messageBody = `Hi ${excelDataUploadRow.name},<br>${rewritten.description}<br><br>${signature?.signatureBody ?? ""}`;
        const token = randomBytes(16).toString("hex");

        await this.prisma.userEmail.create({
          data: {
            parentId: 0,
            userEmail: excelDataUploadRow.email,
            userName: excelDataUploadRow.name,
            userSubject: rewritten.subject,
            userDesc: messageBody,
            userToken: token,
            isDeleted: 0,
            tempGroupId: excelDataUploadRow.groupId,
            excelId: 0,
            groupExcelid: excelDataUploadRow.groupExcelId,
            templateTblId: template.tempId,
            followType: "main",
            followSteps: 0,
            followDate: new Date(),
            isSend: 0,
            senderIp: "",
            smtpSettingId,
          },
        });

        await this.prisma.excelDataUpload.delete({
          where: { id: excelDataUploadRow.id },
        });

        migrated++;
      } catch (error) {
        this.logger.error(
          `Failed to migrate excel_data_upload.id=${excelDataUploadRow.id} | ${error instanceof Error ? error.message : String(error)}`,
        );
        await this.prisma.excelDataUpload.update({
          where: { id: excelDataUploadRow.id },
          data: { isLock: 0 },
        });
      }
    }

    return { migrated, total: excelDataUploadRows.length };
  }

  // Alerts Slack when a group's pending (unsent) main emails drop below
  // settings.daily_email_limit - i.e. it can no longer fill a full day's
  // send, so more emails need to be uploaded. Ported from PHP CronController
  // checkEmailShortage, checked at the end of this cron so it reflects the
  // freshly-migrated counts. Dedupes via settings so it only alerts once
  // per group per calendar day.
  async checkEmailShortage() {
    const webhookSetting = await this.prisma.setting.findUnique({
      where: { key: "slack_webhook_url" },
    });
    const webhookUrl = webhookSetting?.value?.trim();
    if (!webhookUrl) {
      return;
    }

    const globalDailyLimit = await this.getGlobalDailyLimit();

    const groups = await this.prisma.templateGroup.findMany({
      where: { isDelete: "0", archive: 0 },
      select: { id: true, groupeName: true, emailLimitPerDay: true },
    });

    const today = new Date().toISOString().slice(0, 10);

    for (const group of groups) {
      const everLoaded = await this.prisma.userEmail.findFirst({
        where: { tempGroupId: group.id },
        select: { autoId: true },
      });
      if (!everLoaded) {
        continue;
      }

      const { dailyLimit, pendingCount, stock } = await this.groupStock(
        group.id,
        group.emailLimitPerDay,
        globalDailyLimit,
      );
      const importing = stock - pendingCount;

      // Less than a full day's worth left is what "short" means - the sequence
      // cannot fill tomorrow at its own send rate. dispatchPendingEmails holds
      // every send for the group on this same condition via lowStockGroupIds.
      if (stock >= dailyLimit) {
        continue;
      }

      const dedupeKey = `email_shortage_alerted_group_${group.id}`;
      const alreadyAlerted = await this.prisma.setting.findUnique({
        where: { key: dedupeKey },
      });
      if (alreadyAlerted?.value === today) {
        continue;
      }

      const message =
        `*Email Shortage Alert*\nGroup: *${group.groupeName}*\n` +
        `Emails left to send: ${stock} of a ${dailyLimit}/day limit ` +
        `(${pendingCount} ready, ${importing} still importing)\n` +
        `Please upload more emails for this group.`;

      try {
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: message }),
        });

        // fetch only throws on a transport error. A revoked webhook or a deleted
        // channel answers with a 404/403 body, and marking the sequence alerted
        // on that would swallow the alert for the rest of the day.
        if (!response.ok) {
          throw new Error(
            `Slack returned ${response.status} ${await response.text()}`,
          );
        }
      } catch (err) {
        this.logger.error(
          `checkEmailShortage: Slack alert failed | group_id=${group.id} | ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      await this.prisma.setting.upsert({
        where: { key: dedupeKey },
        create: {
          key: dedupeKey,
          value: today,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        update: { value: today, updatedAt: new Date() },
      });

      this.logger.log(
        `checkEmailShortage: notified group ${group.groupeName} (pending=${pendingCount})`,
      );
    }
  }

  // instructionPrompt is the per-step prompt saved from tracking_project's
  // Add a Step form (template_tbl.ai_prompt) - same admin-facing text they
  // previewed with the Generate button, now driving the actual automated
  // rewrite at send time. Falls back to AiRewriteService's default prompt
  // for steps created before this field existed.
  private async rewriteContent(
    subject: string,
    description: string,
    instructionPrompt?: string,
  ) {
    const apiKey = this.configService.get<string>("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return { subject, description };
    }

    // Same pacing as SendgridConsumer's per-email send delay - reused here
    // so a 50-row batch doesn't fire AI calls back-to-back and trip the
    // provider's rate limit. Wait happens BEFORE the call so every single
    // AI request (including the first) is gated.
    const sendDelay = this.configService.get<number>(
      "EMAIL_SEND_DELAY_MS",
      5000,
    );
    await new Promise((resolve) => setTimeout(resolve, sendDelay));

    try {
      return await this.aiRewriteService.rewrite(
        subject,
        description,
        instructionPrompt,
      );
    } catch (error) {
      this.logger.error(
        `AI rewrite failed | ${error instanceof Error ? error.message : String(error)} | falling back to original content`,
      );
      return { subject, description };
    }
  }
}
