import { Module } from "@nestjs/common";
import { RabbitmqPublisherService } from "./rabbitmq-publisher.service";
import { InternalAuthModule } from "../internal-auth/internal-auth.module";

@Module({
  imports: [InternalAuthModule],
  providers: [RabbitmqPublisherService],
  exports: [RabbitmqPublisherService],
})
export class RabbitmqPublisherModule {}
