import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import amqp, {
  AmqpConnectionManager,
  ChannelWrapper,
} from "amqp-connection-manager";
import type { Channel } from "amqplib";
import { EVENTS, QUEUES } from "../constants/rabbitmq.constants";
import { InternalAuthService } from "../internal-auth/internal-auth.service";

// Token only has to survive from publish-time to whenever this instance's
// consumer actually pulls the message off the queue - under a real send
// backlog (EMAIL_SEND_DELAY_MS pacing, hundreds of queued rows) that can be
// well over 5 minutes, so this is long relative to a typical auth token.
const QUEUE_TOKEN_TTL = "24h";

@Injectable()
export class RabbitmqPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitmqPublisherService.name);

  private connection!: AmqpConnectionManager;

  private channelWrapper!: ChannelWrapper;

  constructor(
    private readonly configService: ConfigService,
    private readonly internalAuthService: InternalAuthService,
  ) {}

  onModuleInit() {
    const url = this.configService.getOrThrow<string>("RABBITMQ_URL");

    this.connection = amqp.connect([url]);

    this.channelWrapper = this.connection.createChannel({
      json: false,
      setup: async (channel: Channel) => {
        await channel.assertQueue(QUEUES.EMAIL_DLQ, { durable: true });

        await channel.assertQueue(QUEUES.EMAIL, {
          durable: true,
          arguments: {
            "x-dead-letter-exchange": "",
            "x-dead-letter-routing-key": QUEUES.EMAIL_DLQ,
          },
        });
      },
    });
  }

  async publishSendEmail(data: {
    auto_id: number;
    recipientEmail: string;
    subject: string;
    htmlContent: string;
    settingsId?: number;
    retryCount?: number;
  }) {
    const token = this.internalAuthService.generateToken(
      "rabbitmq-publisher",
      QUEUE_TOKEN_TTL,
    );
    const message = { pattern: EVENTS.SEND_EMAIL, data: { ...data, token } };

    await this.channelWrapper.sendToQueue(
      QUEUES.EMAIL,
      Buffer.from(JSON.stringify(message)),
      { persistent: true },
    );
  }

  async onModuleDestroy() {
    await this.channelWrapper?.close();
    await this.connection?.close();
    this.logger.log("RabbitMQ publisher connection closed");
  }
}
