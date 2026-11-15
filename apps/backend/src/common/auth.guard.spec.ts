import { AuthGuard } from './auth.guard';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';

describe('AuthGuard', () => {
  let guard: AuthGuard;

  beforeEach(() => {
    guard = new AuthGuard();
    process.env.API_PAIRING_TOKEN = 'test-token-123';
  });

  afterEach(() => {
    delete process.env.API_PAIRING_TOKEN;
  });

  const createMockContext = (ip: string, path: string, headers: Record<string, string>): ExecutionContext => {
    const request = {
      ip,
      path,
      headers,
    };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  };

  it('should reject non-localhost IP', () => {
    const ctx = createMockContext('192.168.1.50', '/api/sessions', {
      'x-pairing-token': 'test-token-123',
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should allow /api/health from localhost without token', () => {
    const ctx = createMockContext('127.0.0.1', '/api/health', {});
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should allow /api/config/status from localhost without token', () => {
    const ctx = createMockContext('127.0.0.1', '/api/config/status', {});
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should reject protected route if pairing token is missing or invalid', () => {
    const ctx = createMockContext('127.0.0.1', '/api/sessions', {});
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);

    const invalidCtx = createMockContext('127.0.0.1', '/api/sessions', {
      'x-pairing-token': 'wrong-token',
    });
    expect(() => guard.canActivate(invalidCtx)).toThrow(UnauthorizedException);
  });

  it('should allow protected route with valid pairing token', () => {
    const ctx = createMockContext('127.0.0.1', '/api/sessions', {
      'x-pairing-token': 'test-token-123',
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });
});

