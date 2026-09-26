import { Global, Module } from "@nestjs/common";
import { InternalAuthService } from "./internal-auth.service";

@Global()
@Module({
  providers: [InternalAuthService],
  exports: [InternalAuthService],
})
export class InternalAuthModule {}
