import { Module } from "@nestjs/common";
import { WebhookController } from "./webhook.controller";
import { WebhookService } from "./webhook.service";
import { WebhookEventModule } from "../webhook-event/webhook-event.module";
import { EmailStatusGatewayModule } from "../email-status-gateway/email-status-gateway.module";

@Module({
  imports: [WebhookEventModule, EmailStatusGatewayModule],
  controllers: [WebhookController],
  providers: [WebhookService],
})
export class WebhookModule {}
