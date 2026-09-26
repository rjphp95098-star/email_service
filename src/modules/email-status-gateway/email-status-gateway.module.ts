import { Module } from "@nestjs/common";
import { EmailStatusGateway } from "./email-status.gateway";
import { EmailStatusController } from "./email-status.controller";

@Module({
  controllers: [EmailStatusController],
  providers: [EmailStatusGateway],
  exports: [EmailStatusGateway],
})
export class EmailStatusGatewayModule {}
