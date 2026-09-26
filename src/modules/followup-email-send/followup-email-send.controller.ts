import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiKeyGuard } from "src/common/guards/api-key.guard";
import { FollowupEmailSendService } from "./followup-email-send.service";

@Controller("cron")
export class FollowupEmailSendController {
  constructor(
    private readonly followupEmailSendService: FollowupEmailSendService,
  ) {}

  @UseGuards(ApiKeyGuard)
  @Get("followup-email-send")
  async sendFollowupEmail() {
    return this.followupEmailSendService.dispatchPendingFollowupEmails();
  }
}
