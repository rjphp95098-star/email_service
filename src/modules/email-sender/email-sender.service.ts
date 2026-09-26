import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { SendgridService } from "../sendgrid/sendgrid.service";
import { DomainPacingService } from "../domain-pacing/domain-pacing.service";

export interface QueuedEmail {
  auto_id: number;
  recipientEmail: string;
  subject: string;
  htmlContent: string;
}

export interface SendAndAckOptions {
  data: QueuedEmail;
  autoId: number;
  settingsId: number | undefined;
  channel: any;
  originalMsg: any;
  label: string;
  extraUpdate?: Prisma.UserEmailUpdateInput;
}

// Shared send path for the initial and follow-up queue consumers - they only
// differ in how they pick the sending domain, everything from the send
// onwards (ack, pacing wait, bounded retry) is identical.
@Injectable()
export class EmailSenderService {
  private readonly logger = new Logger(EmailSenderService.name);

  // Bounds how many times a nack'd message gets requeued (via republish, so
  // the attempt count travels in the message headers) before it's given up
  // on and dead-lettered for good - without this a transient failure would
  // either vanish forever (no requeue) or loop the same message forever
  // (unbounded requeue).
  private readonly maxRetries = 3;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sendgridService: SendgridService,
    private readonly domainPacingService: DomainPacingService,
  ) {}

  // Config/data problems (bad sender address, deleted smtp setting) can
  // never succeed on retry - only actual transient failures (SMTP timeout,
  // SendGrid 429/5xx, network blips) are worth requeuing.
  private isRetryable(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return !/unusable sender address|No active smtp setting found/i.test(
      message,
    );
  }

  // Queues the send on the domain's pacing lane, so sends from one domain go
  // out one at a time with the lane's delay between them.
  schedule(options: SendAndAckOptions): Promise<void> {
    return this.domainPacingService.schedule(String(options.settingsId), () =>
      this.sendAndAck(options),
    );
  }

  private async sendAndAck({
    data,
    autoId,
    settingsId,
    channel,
    originalMsg,
    label,
    extraUpdate,
  }: SendAndAckOptions) {
    try {
      await this.sendgridService.sendRawEmail({
        recipientEmail: data.recipientEmail,
        subject: data.subject,
        htmlContent: data.htmlContent,
        autoId,
        settingsId,
      });

      await this.prisma.userEmail.update({
        where: { autoId },
        data: {
          ...extraUpdate,
          isSend: 1,
          smtpSettingId: settingsId,
          sentDate: new Date(),
        },
      });

      channel.ack(originalMsg);

      const delayMs = this.domainPacingService.nextDelayMs(String(settingsId));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    } catch (error) {
      this.logger.error(
        `Failed to fire ${label} email | auto_id=${data.auto_id} | ${error instanceof Error ? error.message : String(error)}`,
      );

      const existingHeaders = originalMsg.properties?.headers || {};
      const headers = { ...existingHeaders };
      const attempt = (Number(headers["x-retry-count"]) || 0) + 1;

      if (this.isRetryable(error) && attempt <= this.maxRetries) {
        headers["x-retry-count"] = attempt;

        channel.publish(
          "",
          originalMsg.fields.routingKey,
          originalMsg.content,
          { ...originalMsg.properties, headers },
        );
        channel.ack(originalMsg);
      } else {
        channel.nack(originalMsg, false, false);
      }
    }
  }
}
