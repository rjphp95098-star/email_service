import { Module } from "@nestjs/common";
import { AiRewriteService } from "./ai-rewrite.service";
import { AiRewriteController } from "./ai-rewrite.controller";

@Module({
  controllers: [AiRewriteController],
  providers: [AiRewriteService],
  exports: [AiRewriteService],
})
export class AiRewriteModule {}
