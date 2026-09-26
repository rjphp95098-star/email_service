import { Module } from "@nestjs/common";
import { WebhookEventService } from "./webhook-event.service";

@Module({
  providers: [WebhookEventService],
  exports: [WebhookEventService],
})
export class WebhookEventModule {}