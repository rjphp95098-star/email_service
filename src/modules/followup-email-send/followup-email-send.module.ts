import { Module } from "@nestjs/common";
import { FollowupEmailSendService } from "./followup-email-send.service";
import { FollowupEmailSendController } from "./followup-email-send.controller";
import { RabbitmqPublisherModule } from "src/common/rabbitmq/rabbitmq-publisher.module";

@Module({
  imports: [RabbitmqPublisherModule],
  controllers: [FollowupEmailSendController],
  providers: [FollowupEmailSendService],
})
export class FollowupEmailSendModule {}
