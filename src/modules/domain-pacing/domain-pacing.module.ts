import { Module } from "@nestjs/common";
import { DomainPacingService } from "./domain-pacing.service";

@Module({
  providers: [DomainPacingService],
  exports: [DomainPacingService],
})
export class DomainPacingModule {}
