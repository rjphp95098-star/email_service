import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { ApiKeyGuard } from "src/common/guards/api-key.guard";
import { EmailStatusGateway } from "./email-status.gateway";
import type { BatchGenerationChangedPayload } from "./email-status.gateway";

// tracking_project's AI content generation (pending/processing/completed/
// failed on the Overview tab) is a PHP-only flow - the standalone AI
// project calls PHP directly over HTTP (SequenceAiWebhookController), not
// through email_service. PHP has no way to push that status to the
// browser itself (a request/response can't stay open), so it relays it
// here the same way it already does for other internal calls (x-internal-
// secret), and this just re-broadcasts it over the socket already used
// for email delivery status.
@Controller("internal")
export class EmailStatusController {
  constructor(private readonly emailStatusGateway: EmailStatusGateway) {}

  @UseGuards(ApiKeyGuard)
  @Post("batch-generation-status")
  notifyBatchGenerationStatus(@Body() body: BatchGenerationChangedPayload) {
    this.emailStatusGateway.notifyBatchGenerationChanged(body);
    return { received: true };
  }
}
