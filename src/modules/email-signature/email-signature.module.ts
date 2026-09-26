import { Module } from "@nestjs/common";
import { EmailSignatureService } from "./email-signature.service";

@Module({
  providers: [EmailSignatureService],
  exports: [EmailSignatureService],
})
export class EmailSignatureModule {}
