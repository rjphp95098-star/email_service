import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { PrismaModule } from "./prisma/prisma.module";
import { SenderAccountModule } from "./modules/sender-account/sender-account.module";
import { SendgridModule } from "./modules/sendgrid/sendgrid.module";
import { EmailTemplateModule } from "./modules/email-template/email-template.module";
import { WebhookModule } from "./modules/webhook/webhook.module";
import { WebhookEventModule } from "./modules/webhook-event/webhook-event.module";
import { FollowupEmailSendModule } from "./modules/followup-email-send/followup-email-send.module";
import { NewEmailSendModule } from "./modules/new-email-send/new-email-send.module";
import { AiRewriteModule } from "./modules/ai-rewrite/ai-rewrite.module";
import { DomainRotationModule } from "./modules/domain-rotation/domain-rotation.module";
import { EmailSignatureModule } from "./modules/email-signature/email-signature.module";
import { InitialEmailQueueModule } from "./modules/initial-email-queue/initial-email-queue.module";
import { FollowupEmailQueueModule } from "./modules/followup-email-queue/followup-email-queue.module";
import { EmailStatusGatewayModule } from "./modules/email-status-gateway/email-status-gateway.module";
import { RabbitmqQueueCleanupModule } from "./common/rabbitmq/rabbitmq-queue-cleanup.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    SenderAccountModule,
    SendgridModule,
    EmailTemplateModule,
    WebhookModule,
    WebhookEventModule,
    FollowupEmailSendModule,
    NewEmailSendModule,
    AiRewriteModule,
    DomainRotationModule,
    EmailSignatureModule,
    InitialEmailQueueModule,
    FollowupEmailQueueModule,
    EmailStatusGatewayModule,
    RabbitmqQueueCleanupModule,
  ],
})
export class AppModule {}
