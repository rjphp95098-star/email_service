import { Controller, Logger } from "@nestjs/common";
import { Ctx, EventPattern, Payload, RmqContext } from "@nestjs/microservices";
import { PrismaService } from "../../prisma/prisma.service";
import { DomainRotationService } from "../domain-rotation/domain-rotation.service";
import { SenderAccountService } from "../sender-account/sender-account.service";
import { EmailSenderService } from "../email-sender/email-sender.service";
import { EVENTS } from "../../common/constants/rabbitmq.constants";

interface FireInitialEmailPayload {
  auto_id: number;
  recipientEmail: string;
  subject: string;
  htmlContent: string;
  sequance_id: number;
}

@Controller()
export class InitialEmailQueueConsumer {
  private readonly logger = new Logger(InitialEmailQueueConsumer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly domainRotationService: DomainRotationService,
    private readonly senderAccountService: SenderAccountService,
    private readonly emailSenderService: EmailSenderService,
  ) {}

  @EventPattern(EVENTS.FIRE_INITIAL_EMAIL)
  async handleFireInitialEmail(
    @Payload() data: FireInitialEmailPayload,
    @Ctx() context: RmqContext,
  ) {
    const channel = context.getChannelRef();
    const originalMsg = context.getMessage();

    const autoId = Number(data.auto_id);
    const sequenceId = Number(data.sequance_id);

    this.logger.log(
      `Picked up from RabbitMQ | queue=${originalMsg.fields.routingKey} | auto_id=${autoId} | email=${data.recipientEmail} | sequance_id=${sequenceId}`,
    );

    // Resolved outside the lane so different messages can look this up
    // concurrently - only the actual send+pace is serialized.
    let settingsId: number | undefined;
    try {
      const templateGroup = await this.prisma.templateGroup.findUnique({
        where: { id: sequenceId },
        select: { settingsId: true },
      });
      const domain =
        await this.domainRotationService.getActiveDomainForWorkingWeek(
          sequenceId,
        );
      settingsId = domain?.id ?? (templateGroup?.settingsId || undefined);

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
      label: "initial",
    });
  }
}
