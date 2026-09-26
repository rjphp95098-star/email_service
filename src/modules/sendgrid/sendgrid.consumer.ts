import { Controller, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Ctx, EventPattern, Payload, RmqContext } from "@nestjs/microservices";
import { SendgridService } from "./sendgrid.service";
import { EVENTS } from "../../common/constants/rabbitmq.constants";
import { InternalAuthService } from "../../common/internal-auth/internal-auth.service";
import { RabbitmqPublisherService } from "../../common/rabbitmq/rabbitmq-publisher.service";

interface EmailQueuePayload {
  auto_id: number;
  recipientEmail: string;
  subject: string;
  htmlContent: string;
  settingsId?: number;
  token: string;
  retryCount?: number;
}

const MAX_TRANSIENT_RETRIES = 5;
const MAX_BACKOFF_MS = 5 * 60_000;

// SendGrid blips and network errors are worth retrying; a bad request, a
// missing sender config, or a forged/expired token will fail identically no
// matter how many times it's retried - retrying those just delays the DLQ.
// Node's own connection errors put their code as a STRING on `.code`
// (ECONNRESET etc); @sendgrid/mail's ResponseError puts the HTTP status as a
// NUMBER on the same property - the two are told apart by that type check.
function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;

  if (typeof code === "string") {
    return [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
    ].includes(code);
  }

  if (typeof code === "number") {
    return code === 429 || code >= 500;
  }

  return false;
}

@Controller()
export class SendgridConsumer {
  private readonly logger = new Logger(SendgridConsumer.name);

  private readonly sendDelay: number;

  constructor(
    private readonly sendgridService: SendgridService,
    private readonly configService: ConfigService,
    private readonly internalAuthService: InternalAuthService,
    private readonly rabbitmqPublisher: RabbitmqPublisherService,
  ) {
    this.sendDelay = this.configService.get<number>(
      "EMAIL_SEND_DELAY_MS",
      5000,
    );
  }

  @EventPattern(EVENTS.SEND_EMAIL)
  async handleSendEmail(
    @Payload() data: EmailQueuePayload,
    @Ctx() context: RmqContext,
  ) {
    const channel = context.getChannelRef();
    const originalMsg = context.getMessage();
    const retryCount = data.retryCount ?? 0;

    try {
      // Verified inside this try/catch (not a CanActivate guard) so a bad
      // token nacks straight to the DLQ through the same path as any other
      // permanent failure below, instead of skipping ack/nack entirely -
      // with noAck:false, an exception thrown outside this block never
      // reaches channel.ack/nack, and RabbitMQ redelivers it forever.
      this.internalAuthService.verifyToken(data.token);

      this.logger.log(
        `RabbitMQ consumed message | auto_id=${data.auto_id} | to=${data.recipientEmail}` +
          (retryCount > 0
            ? ` | retry ${retryCount}/${MAX_TRANSIENT_RETRIES}`
            : ""),
      );

      const result = await this.sendgridService.sendRawEmail({
        recipientEmail: data.recipientEmail,
        subject: data.subject,
        htmlContent: data.htmlContent,
        autoId: data.auto_id,
        settingsId: data.settingsId,
      });

      channel.ack(originalMsg);

      this.logger.log(
        result.skippedDuplicate
          ? `Redelivered message for auto_id=${data.auto_id} skipped (already sent) | waiting ${this.sendDelay}ms`
          : `RabbitMQ fired email | auto_id=${data.auto_id} | waiting ${this.sendDelay}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, this.sendDelay));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (isTransientError(error) && retryCount < MAX_TRANSIENT_RETRIES) {
        const backoff = Math.min(
          this.sendDelay * 2 ** retryCount,
          MAX_BACKOFF_MS,
        );

        this.logger.warn(
          `Email failed (transient, will retry) | auto_id=${data.auto_id} | attempt ${retryCount + 1}/${MAX_TRANSIENT_RETRIES} in ${backoff}ms | ${message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoff));

        // Ack the original before publishing the retry, not after: if the
        // process dies in between, this one retry is lost (recoverable only
        // by manually re-checking the row) rather than risking the original
        // message ALSO surviving and firing a second real send alongside
        // the republished copy.
        channel.ack(originalMsg);

        try {
          await this.rabbitmqPublisher.publishSendEmail({
            auto_id: data.auto_id,
            recipientEmail: data.recipientEmail,
            subject: data.subject,
            htmlContent: data.htmlContent,
            settingsId: data.settingsId,
            retryCount: retryCount + 1,
          });
        } catch (republishError) {
          this.logger.error(
            `Failed to re-queue retry ${retryCount + 1} for auto_id=${data.auto_id} - it will NOT be retried automatically | ${republishError instanceof Error ? republishError.message : String(republishError)}`,
          );
        }

        return;
      }

      this.logger.error(
        `Email failed permanently | auto_id=${data.auto_id} | retries=${retryCount} | ${message}`,
      );
      channel.nack(originalMsg, false, false);
      await new Promise((resolve) => setTimeout(resolve, this.sendDelay));
    }
  }
}
