import { Module } from "@nestjs/common";
import { FollowupEmailQueueConsumer } from "./followup-email-queue.consumer";
import { EmailSenderModule } from "../email-sender/email-sender.module";
import { SenderAccountModule } from "../sender-account/sender-account.module";

@Module({
  imports: [EmailSenderModule, SenderAccountModule],
  controllers: [FollowupEmailQueueConsumer],
})
export class FollowupEmailQueueModule {}
