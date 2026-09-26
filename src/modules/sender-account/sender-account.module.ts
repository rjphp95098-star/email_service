import { Module } from "@nestjs/common";
import { SenderAccountService } from "./sender-account.service";

@Module({
  providers: [SenderAccountService],
  exports: [SenderAccountService],
})
export class SenderAccountModule {}