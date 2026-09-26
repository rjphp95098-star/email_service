import { Controller, Logger } from "@nestjs/common";
import { Ctx, EventPattern, Payload, RmqContext } from "@nestjs/microservices";
import { PrismaService } from "../../prisma/prisma.service";
import { SenderAccountService } from "../sender-account/sender-account.service";
import { EmailSenderService } from "../email-sender/email-sender.service";
import { EVENTS } from "../../common/constants/rabbitmq.constants";

interface FireFollowupEmailPayload {
  auto_id: number;
  parent_id: number;
  recipientEmail: string;
  subject: string;
  htmlContent: string;
  sequance_id: number;
}

@Controller()
export class FollowupEmailQueueConsumer {
  private readonly logger = new Logger(FollowupEmailQueueConsumer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly senderAccountService: SenderAccountService,
    private readonly emailSenderService: EmailSenderService,
  ) {}

  @EventPattern(EVENTS.FIRE_FOLLOWUP_EMAIL)
  async handleFireFollowupEmail(
    @Payload() data: FireFollowupEmailPayload,
    @Ctx() context: RmqContext,
  ) {
    const channel = context.getChannelRef();
    const originalMsg = context.getMessage();

    // PHP's CI3 mysqli driver hands back every column as a string, so these
    // arrive over the queue as JSON strings (e.g. "21") rather than numbers.
    const autoId = Number(data.auto_id);
    const parentId = Number(data.parent_id);
    const sequenceId = Number(data.sequance_id);

    // A follow-up MUST use the domain its Initial Email actually sent from,
    // never the sequence's current rotation slot (DomainRotationService is
    // for brand-new Initial Emails only - see its class comment) - otherwise
    // a follow-up sent weeks later can go out from a different domain than
    // the thread it's replying to. Resolved outside the lane so different
    // messages can look this up concurrently - only the actual send+pace is
    // serialized.
    let settingsId: number | undefined;
    try {
      const parent = await this.prisma.userEmail.findUnique({
        where: { autoId: parentId },
        select: { smtpSettingId: true },
      });
      const templateGroup = await this.prisma.templateGroup.findUnique({
        where: { id: sequenceId },
        select: { settingsId: true },
      });
      settingsId =
        parent?.smtpSettingId ?? (templateGroup?.settingsId || undefined);

      if (settingsId === undefined) {
        const fallbackSender =
          await this.senderAccountService.getOrRotateSender();
        settingsId = fallbackSender.id;
      }
    } catch (error) {
      this.logger.error(
        `Failed to resolve sending domain | auto_id=${data.auto_id} | ${error instanceof Error ? error.message : String(error)}`,
      );
      channel.nack(originalMsg, false, false);
      return;
    }

    return this.emailSenderService.schedule({
      data,
      autoId,
      settingsId,
      channel,
      originalMsg,
      label: "follow-up",
      extraUpdate: { emailStatus: "sent" },
    });
  }
}
