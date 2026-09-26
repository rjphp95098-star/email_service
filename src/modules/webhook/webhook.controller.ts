import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { WebhookService } from "./webhook.service";
import { SendgridWebhookGuard } from "src/common/guards/sendgrid-webhook.guard";

@Controller("webhooks")
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Post("sendgrid")
  @UseGuards(SendgridWebhookGuard)
  async handleSendgridWebhook(@Body() payload: any[]) {
    return this.webhookService.processEvents(payload);
  }
}
