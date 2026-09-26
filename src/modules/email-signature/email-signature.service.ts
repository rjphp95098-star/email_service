import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "src/prisma/prisma.service";

@Injectable()
export class EmailSignatureService {
  private readonly logger = new Logger(EmailSignatureService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Appends the sender account's assigned signature (if any) to the bottom
   * of an outgoing email's HTML body. No smtpSettingId, no signature
   * assigned on that row, or a deleted/missing signature - html comes back
   * unchanged, nothing appended.
   */
  async appendIfAssigned(
    html: string,
    smtpSettingId: number | null | undefined,
  ): Promise<string> {
    if (!smtpSettingId) {
      return html;
    }

    try {
      const signature = await this.prisma.emailSignature.findFirst({
        where: { smtpId: smtpSettingId, isDeleted: 0 },
        select: { content: true },
      });

      if (!signature) {
        return html;
      }

      return `${html}<br><br>${signature.content}`;
    } catch (error) {
      // A broken signature lookup must never block the email itself from
      // going out - fall back to the unmodified body and just log it.
      this.logger.error(
        `appendIfAssigned: failed to load signature for smtpSettingId=${smtpSettingId} | ${error instanceof Error ? error.message : String(error)}`,
      );
      return html;
    }
  }
}
