import { Module } from "@nestjs/common";
import { InitialEmailQueueConsumer } from "./initial-email-queue.consumer";
import { DomainRotationModule } from "../domain-rotation/domain-rotation.module";
import { EmailSenderModule } from "../email-sender/email-sender.module";
import { SenderAccountModule } from "../sender-account/sender-account.module";

@Module({
  imports: [
    DomainRotationModule,
    EmailSenderModule,
    SenderAccountModule,
  ],
  controllers: [InitialEmailQueueConsumer],
})
export class InitialEmailQueueModule {}
