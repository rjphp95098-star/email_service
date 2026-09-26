import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { ApiKeyGuard } from "src/common/guards/api-key.guard";
import { AiRewriteService } from "./ai-rewrite.service";

interface RewritePreviewBody {
  subject: string;
  description: string;
  instructionPrompt?: string;
}

@Controller("ai")
export class AiRewriteController {
  constructor(private readonly aiRewriteService: AiRewriteService) {}

  @UseGuards(ApiKeyGuard)
  @Post("rewrite-preview")
  async rewritePreview(@Body() body: RewritePreviewBody) {
    const rewritten = await this.aiRewriteService.rewrite(
      body.subject,
      body.description,
      body.instructionPrompt,
    );
    return {
      subject: rewritten.subject,
      description: rewritten.description,
      defaultPrompt: this.aiRewriteService.getDefaultPrompt(),
    };
  }
}
