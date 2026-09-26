import { BadGatewayException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

// Kept separate from NewEmailSendService.rewriteContent on purpose - this is
// an interactive, single-call preview triggered by an admin clicking
// "Generate" (tracking_project's Add a Step form), not the throttled,
// bulk-pacing rewrite used by the automated migration cron. Duplicating the
// Anthropic call here avoids touching that already-working pipeline.
// Admin-facing part of the prompt (shown/editable in tracking_project's Add
// a Step form). The JSON-shape contract below is NOT part of this - it's
// always appended server-side (see JSON_SHAPE_SUFFIX) so parsing stays
// reliable even when an admin overrides this text with their own wording.
const DEFAULT_INSTRUCTION_PROMPT = `Reword the following email subject and body so the wording is different from the original while keeping the same meaning, tone, and length roughly the same. Keep any placeholder tokens exactly as-is exactly as they are in the original - only reword the text content between/around them, do not add, remove, or restructure tags. Respond with ONLY a JSON object, no other text, in this exact shape`;

// Always appended after the instruction text (default or admin-edited) -
// completes that sentence's "...in this exact shape" with the actual
// contract the parser below depends on.
const JSON_SHAPE_SUFFIX = `: {"subject": "...", "description": "..."}.`;

interface AiRewriteResponse {
  content: { text: string }[];
}

interface RewrittenContent {
  subject: string;
  description: string;
}

@Injectable()
export class AiRewriteService {
  private readonly logger = new Logger(AiRewriteService.name);

  constructor(private readonly configService: ConfigService) {}

  getDefaultPrompt(): string {
    return DEFAULT_INSTRUCTION_PROMPT;
  }

  async rewrite(
    subject: string,
    description: string,
    instructionPrompt?: string,
  ): Promise<RewrittenContent> {
    const apiKey = this.configService.get<string>("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new BadGatewayException("ANTHROPIC_API_KEY is not configured");
    }

    const instructions =
      (instructionPrompt?.trim() || DEFAULT_INSTRUCTION_PROMPT) +
      JSON_SHAPE_SUFFIX;
    const prompt = `${instructions}

    Subject: ${subject}
    Body: ${description}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error(
        `AI rewrite failed | HTTP ${response.status} | ${errorBody}`,
      );
      throw new BadGatewayException(
        `AI rewrite failed (HTTP ${response.status})`,
      );
    }

    const data = (await response.json()) as AiRewriteResponse;
    const text = data.content?.[0]?.text ?? "";
    // Model sometimes wraps the JSON in a ```json ... ``` fence despite
    // being told not to - extract the {...} body before parsing.
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    const jsonText =
      jsonStart !== -1 && jsonEnd !== -1
        ? text.slice(jsonStart, jsonEnd + 1)
        : text;

    let parsed: RewrittenContent;
    try {
      parsed = JSON.parse(jsonText) as RewrittenContent;
    } catch {
      throw new BadGatewayException("AI response was not valid JSON");
    }

    if (!parsed.subject || !parsed.description) {
      throw new BadGatewayException(
        "Missing subject/description in AI rewrite response",
      );
    }

    return { subject: parsed.subject, description: parsed.description };
  }
}
