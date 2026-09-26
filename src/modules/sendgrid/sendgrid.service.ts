import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EmailStatus } from "@prisma/client";
import sgMail from "@sendgrid/mail";
import { SenderAccountService } from "../sender-account/sender-account.service";
import { EmailSignatureService } from "../email-signature/email-signature.service";
import { PrismaService } from "src/prisma/prisma.service";

@Injectable()
export class SendgridService {
  private readonly logger = new Logger(SendgridService.name);

  // Prefix for the sendGridId claim marker written before a send is attempted.
  // Distinguishes "another attempt is currently in flight for this row" from
  // "this row already has a real SendGrid message id" - a real id never has
  // this shape.
  private readonly claimPrefix = "CLAIMED:";

  constructor(
    private readonly configService: ConfigService,
    private readonly senderAccountService: SenderAccountService,
    private readonly emailSignatureService: EmailSignatureService,
    private readonly prisma: PrismaService,
  ) {
    sgMail.setApiKey(this.configService.getOrThrow<string>("SENDGRID_API_KEY"));
  }

  async sendRawEmail(data: {
    recipientEmail: string;
    subject: string;
    htmlContent: string;
    autoId: number;
    settingsId?: number;
  }) {
  
    const claimMarker = this.claimPrefix + Date.now();
    const claim = await this.prisma.userEmail.updateMany({
      where: { autoId: data.autoId, sendGridId: null },
      data: { sendGridId: claimMarker },
    });

    if (claim.count === 0) {
      const existing = await this.prisma.userEmail.findUnique({
        where: { autoId: data.autoId },
        select: { sendGridId: true },
      });
      this.logger.warn(
        `sendRawEmail: auto_id=${data.autoId} already sent or in flight (sendGridId=${existing?.sendGridId}) - skipping redelivered duplicate`,
      );
      return {
        success: true,
        skippedDuplicate: true,
        sendgridMessageId: existing?.sendGridId ?? "",
      };
    }

    // Each sequence sends from its own fixed domain (template_grouptbl.settings_id)
    // instead of the shared round-robin pool. Round-robin is only a fallback
    // for rows with no settings_id or a settings_id that's been deleted.
    let sender = data.settingsId
      ? await this.senderAccountService.getSenderById(data.settingsId)
      : null;
    if (!sender) {
      sender = await this.senderAccountService.getOrRotateSender();
    }

    if (!sender) {
      throw new Error("No active smtp setting found");
    }

    // Caught here rather than as a 400 from SendGrid: smtp_settings.id=8 had
    // "pinesucceedtechhub.com" in sender_email - a domain, with no local part -
    // and every send came back "Bad Request" with nothing saying why.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sender.fromEmail ?? "")) {
      throw new Error(
        `smtp setting ${sender.id} has an unusable sender address: "${sender.fromEmail}"`,
      );
    }

    const htmlContent = await this.emailSignatureService.appendIfAssigned(
      data.htmlContent,
      sender.id,
    );

    await this.prisma.userEmail.update({
      where: { autoId: data.autoId },
      data: { emailStatus: EmailStatus.QUEUED },
    });

    try {
      const [response] = await sgMail.send({
        to: data.recipientEmail,
        from: { email: sender.fromEmail, name: sender.fromName },
        subject: data.subject,
        html: htmlContent,
        customArgs: { auto_id: String(data.autoId) },
      });

      const sendgridMessageId = response.headers["x-message-id"] as string;

      // Keep the message id on the row. SendGrid strips custom args off some
      // events (bounce and unsubscribe notably), so those arrive with no
      // auto_id - and the only way back to the row is this id, which is how the
      // PHP webhook resolved them too (user_emails.sendGridId). updateMany so a
      // row deleted since the send doesn't throw.
      if (data.autoId && sendgridMessageId) {
        await this.prisma.userEmail.updateMany({
          where: { autoId: data.autoId },
          data: { sendGridId: sendgridMessageId },
        });
      }

      await this.prisma.userEmail.update({
        where: { autoId: data.autoId },
        data: { emailStatus: EmailStatus.PROCESSED },
      });
      await this.senderAccountService.incrementSentCount(sender.id);

      this.logger.log(`Raw email sent | autoId=${data.autoId}`);

      return {
        success: true,
        skippedDuplicate: false,
        sendgridMessageId,
      };
    } catch (error) {
      await this.prisma.userEmail.updateMany({
        where: { autoId: data.autoId, sendGridId: claimMarker },
        data: { sendGridId: null },
      });
      await this.prisma.userEmail.update({
        where: { autoId: data.autoId },
        data: { emailStatus: EmailStatus.FAILED },
      });

      // sgMail rejects with just "Bad Request" - what SendGrid actually objected
      // to is in response.body.errors, and without it a rejected send says
      // nothing at all.
      const body = (error as { response?: { body?: unknown } })?.response?.body;
      const detail = body ? ` | ${JSON.stringify(body)}` : "";

      this.logger.error(
        `Send failed | autoId=${data.autoId} | to=${data.recipientEmail} | ${
          error instanceof Error ? error.message : String(error)
        }${detail}`,
      );

      throw error;
    }
  }
}
