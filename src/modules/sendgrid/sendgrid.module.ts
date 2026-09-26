import { Module } from "@nestjs/common";
import { SendgridService } from "./sendgrid.service";
import { SendgridController } from "./sendgrid.controller";
import { SendgridConsumer } from "./sendgrid.consumer";
import { SenderAccountModule } from "../sender-account/sender-account.module";
import { InternalAuthModule } from "../../common/internal-auth/internal-auth.module";
import { RabbitmqPublisherModule } from "../../common/rabbitmq/rabbitmq-publisher.module";
import { EmailSignatureModule } from "../email-signature/email-signature.module";

@Module({
  imports: [
    SenderAccountModule,
    InternalAuthModule,
    RabbitmqPublisherModule,
    EmailSignatureModule,
  ],
  controllers: [SendgridController, SendgridConsumer],
  providers: [SendgridService],
  exports: [SendgridService],
})
export class SendgridModule {}
