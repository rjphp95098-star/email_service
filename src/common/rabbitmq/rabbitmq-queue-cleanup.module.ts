import { Module } from "@nestjs/common";
import { RabbitmqQueueCleanupService } from "./rabbitmq-queue-cleanup.service";

@Module({
  providers: [RabbitmqQueueCleanupService],
})
export class RabbitmqQueueCleanupModule {}
