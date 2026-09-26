import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiKeyGuard } from "src/common/guards/api-key.guard";
import { NewEmailSendService } from "./new-email-send.service";

@Controller("cron")
export class NewEmailSendController {
  constructor(private readonly newEmailSendService: NewEmailSendService) {}

  @UseGuards(ApiKeyGuard)
  @Get("new-email-send")
  async newEmailSend() {
    return this.newEmailSendService.runNewEmailSendCron();
  }
}
