import { Module } from "@nestjs/common";
import { DomainRotationService } from "./domain-rotation.service";

@Module({
  providers: [DomainRotationService],
  exports: [DomainRotationService],
})
export class DomainRotationModule {}
