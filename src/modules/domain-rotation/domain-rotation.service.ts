import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "src/prisma/prisma.service";
import {
  DEFAULT_TIME_ZONE,
  calendarWeeksBetween,
  zonedAt,
  zonedNow,
} from "src/common/time/zoned-time.util";

// Decides which domain a sequence's NEW Initial Emails go out from this
// working week. Nothing here ever runs for an existing follow-up - a
// follow-up reuses the domain already stored on its Initial Email
// (FollowupEmailSendService reads user_emails.smtp_setting_id directly), so
// changing a sequence's pool or its current week never moves an
// already-scheduled follow-up onto a different domain.
//
// The pool lives in sequence_smtp_settings (SequenceSmtpSetting.groupId maps
// its sequence_id column, which is template_grouptbl.id under this table's
// own naming). Rotation order is insertion order (id ascending) - the table
// has no separate order column, so the order domains were added in is the
// order they rotate in.
//
// Returns null - never throws - for any sequence without a configured pool,
// or whose pool points at a deleted SmtpSetting: a sequence not yet migrated
// onto rotation is an expected, ongoing state (not every sequence has a pool
// configured yet), not an error condition. Callers fall back to that
// sequence's legacy fixed domain in that case, exactly like they already do
// for a row created before this feature existed. Only a groupId that matches
// no template_grouptbl row at all - a genuine caller bug, not a rollout
// state - throws.
@Injectable()
export class DomainRotationService {
  private readonly logger = new Logger(DomainRotationService.name);

  constructor(private readonly prisma: PrismaService) {}

  // The domain a brand-new Initial Email for `groupId` should use right now,
  // or null if this sequence has no rotation pool configured (or a broken
  // one) - see the class comment for why that's not an error here.
  // Week 1 (the sequence's own start_date week) uses the pool's first domain,
  // week 2 the next, and so on, wrapping back to the start once every domain
  // in the pool has had its week - so a 3-domain pool repeats D1/D2/D3 every
  // three weeks rather than running out.
  async getActiveDomainForWorkingWeek(groupId: number) {
    const group = await this.prisma.templateGroup.findUnique({
      where: { id: groupId },
      select: { startDate: true, timezone: true },
    });
    if (!group) {
      throw new Error(
        `getActiveDomainForWorkingWeek: no template group ${groupId}`,
      );
    }

    const timeZone = group.timezone || DEFAULT_TIME_ZONE;

    const pool = await this.prisma.sequenceSmtpSetting.findMany({
      where: { groupId },
      orderBy: { id: "asc" },
      select: { smtpSettingId: true },
    });
    if (pool.length === 0) {
      this.logger.warn(
        `getActiveDomainForWorkingWeek: sequence ${groupId} has no domain pool configured in sequence_smtp_settings - caller should fall back to its legacy domain`,
      );
      return null;
    }

    const startWeek = zonedAt(group.startDate, timeZone).date;
    const currentWeek = zonedNow(timeZone).date;
    // Clamped at 0: a start_date in the future (or a clock skew) must not
    // wrap the index backwards through the pool.
    const weekIndex = Math.max(0, calendarWeeksBetween(startWeek, currentWeek));
    const slot = pool[weekIndex % pool.length];

    const sender = await this.prisma.smtpSetting.findFirst({
      where: { id: slot.smtpSettingId, isDeleted: 0 },
    });
    if (!sender) {
      this.logger.warn(
        `getActiveDomainForWorkingWeek: smtp setting ${slot.smtpSettingId} for sequence ${groupId} is missing or deleted - caller should fall back to its legacy domain`,
      );
      return null;
    }

    this.logger.log(
      `getActiveDomainForWorkingWeek: sequence ${groupId} week ${weekIndex + 1} -> smtp_setting ${sender.id}`,
    );

    return sender;
  }
}
