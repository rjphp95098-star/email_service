import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { SendgridService } from "./sendgrid.service";
import { ApiKeyGuard } from "src/common/guards/api-key.guard";

@Controller("sendgrid")
export class SendgridController {
  constructor(private readonly sendgridService: SendgridService) {}

  @UseGuards(ApiKeyGuard)
  @Post("send")
  async send(
    @Body()
    body: {
      recipientEmail: string;
      subject: string;
      htmlContent: string;
      autoId: number;
    },
  ) {
    return this.sendgridService.sendRawEmail(body);
  }
}
