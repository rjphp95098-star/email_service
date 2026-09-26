import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const key = request.headers["x-internal-secret"];
    const expected = this.configService.get<string>("INTERNAL_SERVICE_SECRET");

    if (!key || key !== expected) {
      throw new UnauthorizedException("Invalid or missing API key");
    }

    return true;
  }
}
