import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InternalAuthService } from '../internal-auth/internal-auth.service';

@Injectable()
export class InternalAuthGuard
  implements CanActivate
{
  private readonly logger = new Logger(InternalAuthGuard.name);

  constructor(
    private readonly internalAuthService: InternalAuthService,
  ) {}

  canActivate(
    context: ExecutionContext,
  ): boolean {
    const data =
      context.switchToRpc().getData();

    const token = data?.token;

    if (!token) {
      throw new UnauthorizedException(
        'Token missing',
      );
    }

    try {
      this.internalAuthService.verifyToken(
        token,
      );

      return true;
    } catch {
      this.logger.warn('Rejected message: invalid internal token');
      throw new UnauthorizedException(
        'Invalid token',
      );
    }
  }
}