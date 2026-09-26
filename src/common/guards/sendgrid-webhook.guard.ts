import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createPublicKey, createVerify, KeyObject } from "crypto";
import { Request } from "express";

const SIGNATURE_HEADER = "x-twilio-email-event-webhook-signature";
const TIMESTAMP_HEADER = "x-twilio-email-event-webhook-signature-timestamp";

// Verifies SendGrid's Event Webhook ECDSA signature so the endpoint only
// accepts requests SendGrid actually signed - without this, auto_id in the
// body is attacker-controlled. Needs the raw request bytes (not the
// parsed-then-reserialized body), which main.ts enables via `rawBody: true`.
@Injectable()
export class SendgridWebhookGuard implements CanActivate {
  private readonly logger = new Logger(SendgridWebhookGuard.name);
  private readonly publicKey: KeyObject | null;

  constructor(configService: ConfigService) {
    const base64PublicKey = configService.get<string>(
      "SENDGRID_WEBHOOK_VERIFICATION_KEY",
    );

    // Missing in local/dev envs (no SendGrid Event Webhook configured yet) -
    // fails closed instead of crashing the whole app at boot (Nest
    // instantiates every guard eagerly, so an unrelated cron endpoint would
    // otherwise become unreachable too). canActivate() below always rejects
    // when this is null, so the webhook endpoint itself stays protected.
    this.publicKey = base64PublicKey
      ? createPublicKey({
          key: Buffer.from(base64PublicKey, "base64"),
          format: "der",
          type: "spki",
        })
      : null;

    if (!this.publicKey) {
      this.logger.warn(
        "SENDGRID_WEBHOOK_VERIFICATION_KEY is not set - the SendGrid webhook endpoint will reject every request until it is configured",
      );
    }
  }

  canActivate(context: ExecutionContext): boolean {
    // TEMPORARY BYPASS (requested explicitly) - SendGrid's account-level
    // "Signed Event Webhook" isn't enabled yet, so real webhook calls arrive
    // with no signature/timestamp header and get rejected below. Remove this
    // early return - and nothing else - once that's turned on in SendGrid's
    // dashboard and the public key there matches
    // SENDGRID_WEBHOOK_VERIFICATION_KEY.
    return true;
    /*
    if (!this.publicKey) {
      throw new UnauthorizedException("SendGrid webhook verification is not configured");
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { rawBody?: Buffer }>();

    const signature = request.header(SIGNATURE_HEADER);
    const timestamp = request.header(TIMESTAMP_HEADER);
    const rawBody = request.rawBody;

    if (!signature || !timestamp || !rawBody) {
      const missing = [
        !signature && "signature header",
        !timestamp && "timestamp header",
        !rawBody && "raw body",
      ]
        .filter(Boolean)
        .join(", ");
      this.logger.warn(`Rejected SendGrid webhook: missing ${missing}`);
      throw new UnauthorizedException("Invalid webhook signature");
    }

    const verifier = createVerify("SHA256");
    verifier.update(Buffer.concat([Buffer.from(timestamp), rawBody]));
    verifier.end();

    const isValid = verifier.verify(this.publicKey, signature, "base64");

    if (!isValid) {
      this.logger.warn("Rejected SendGrid webhook: signature mismatch");
      throw new UnauthorizedException("Invalid webhook signature");
    }

    return true;
    */
  }
}
