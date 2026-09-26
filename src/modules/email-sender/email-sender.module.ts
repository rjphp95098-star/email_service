import { Module } from "@nestjs/common";
import { EmailSenderService } from "./email-sender.service";
import { SendgridModule } from "../sendgrid/sendgrid.module";
import { DomainPacingModule } from "../domain-pacing/domain-pacing.module";

@Module({
  imports: [SendgridModule, DomainPacingModule],
  providers: [EmailSenderService],
  exports: [EmailSenderService],
})
export class EmailSenderModule {}
