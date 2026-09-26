import {
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';

import * as jwt from 'jsonwebtoken';

@Injectable()
export class InternalAuthService {
  private readonly logger =
    new Logger(
      InternalAuthService.name,
    );

  private readonly secret =
    process.env.INTERNAL_SERVICE_SECRET!;

  constructor() {
    if (!this.secret) {
      throw new Error(
        'INTERNAL_SERVICE_SECRET is missing',
      );
    }
  }

  generateToken(
    service: string,
    expiresIn: jwt.SignOptions['expiresIn'] = '5m',
  ) {
    this.logger.log(
      `Generating token for service: ${service}`,
    );

    return jwt.sign(
      {
        service,
      },

      this.secret,

      {
        expiresIn,
      },
    );
  }

  verifyToken(token: string) {
    try {
      this.logger.log(
        'Verifying internal token',
      );

      const decoded = jwt.verify(
        token,
        this.secret,
      ) as {
        service: string;
      };

      this.logger.log(
        `Authenticated service: ${decoded.service}`,
      );

      return decoded;
    } catch (error) {
      this.logger.error(
        'Internal token verification failed',
      );

      throw new UnauthorizedException(
        'Invalid internal token',
      );
    }
  }
}