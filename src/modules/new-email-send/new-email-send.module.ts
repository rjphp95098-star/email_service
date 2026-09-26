import { Module } from "@nestjs/common";
import { NewEmailSendService } from "./new-email-send.service";
import { NewEmailSendController } from "./new-email-send.controller";
import { RabbitmqPublisherModule } from "src/common/rabbitmq/rabbitmq-publisher.module";
import { AiRewriteModule } from "../ai-rewrite/ai-rewrite.module";
import { DomainRotationModule } from "../domain-rotation/domain-rotation.module";

@Module({
  imports: [
    RabbitmqPublisherModule,
    AiRewriteModule,
    DomainRotationModule,
  ],
  controllers: [NewEmailSendController],
  providers: [NewEmailSendService],
})
export class NewEmailSendModule {}
