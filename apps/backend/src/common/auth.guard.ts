import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    // 1. Verify localhost origin / IP
    const clientIp =
      request.ip ||
      request.connection.remoteAddress ||
      request.socket.remoteAddress;

    const isLocalhost =
      clientIp === '127.0.0.1' ||
      clientIp === '::1' ||
      clientIp === '::ffff:127.0.0.1' ||
      clientIp === 'localhost';

    if (!isLocalhost) {
      throw new ForbiddenException('Access denied: backend binds to localhost only');
    }

    // 2. Health check, root, test-portal, and config status checks are allowed for discovery
    const path = request.path;
    if (path === '/' || path === '/api/health' || path === '/api/config/status' || path === '/test-portal') {
      return true;
    }

    // 3. Verify pairing token if set in environment
    const expectedToken = process.env.API_PAIRING_TOKEN || 'ai_mcq_assistant_secret_token_change_in_production';
    const providedToken =
      request.headers['x-pairing-token'] ||
      (request.headers.authorization && request.headers.authorization.replace('Bearer ', ''));

    if (expectedToken && (!providedToken || providedToken !== expectedToken)) {
      throw new UnauthorizedException('Invalid or missing extension pairing token');
    }

    return true;
  }
}

