import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { CurrentUser, Public, ReqMeta, AllowInactiveOrg } from '../../common/decorators';
import { ApiEnvelope, ApiStandardErrors, OkDto } from '../../common/swagger';
import type { AppConfig } from '../../config/configuration';
import { UnauthorizedError } from '../../database/errors';
import { UserDto } from '../users/dto/user.dto';
import { UsersService } from '../users/users.service';
import { AuthService, IssuedTokens } from './auth.service';
import { AuthTokensDto, ChangePasswordDto, ForgotPasswordDto, LoginDto, RefreshDto, RegisterDto, ResetPasswordDto } from './dto/auth.dto';

const RT_COOKIE = 'tirvona_rt';
// Strict per-IP budget on credential endpoints (brute force / credential stuffing).
const authLimit = () => Throttle({ default: { limit: Number(process.env.THROTTLE_AUTH_LIMIT ?? 5), ttl: 60_000 } });

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Public()
  @authLimit()
  @Post('register')
  @ApiOperation({ summary: 'Create an organization and its owner account, then sign in' })
  @ApiEnvelope(AuthTokensDto, { status: 201 })
  @ApiStandardErrors({ auth: false, conflict: 'EMAIL_TAKEN' })
  async register(@Body() dto: RegisterDto, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    return this.withCookie(res, await this.auth.register(dto, meta));
  }

  @Public()
  @authLimit()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in with email and password' })
  @ApiEnvelope(AuthTokensDto)
  @ApiStandardErrors({ auth: false })
  async login(@Body() dto: LoginDto, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    return this.withCookie(res, await this.auth.login(dto, meta));
  }

  @Public()
  @authLimit()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange a refresh token for new tokens (the old refresh token is invalidated)' })
  @ApiEnvelope(AuthTokensDto)
  @ApiStandardErrors({ auth: false })
  async refresh(@Body() dto: RefreshDto, @Req() req: Request, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const token = dto.refreshToken ?? (req.cookies?.[RT_COOKIE] as string | undefined);
    if (!token) throw new UnauthorizedError('Refresh token required', 'TOKEN_INVALID');
    return this.withCookie(res, await this.auth.refresh(token, meta));
  }

  @AllowInactiveOrg()
  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'End the current login (all tokens of this session family stop working immediately)' })
  @ApiEnvelope(OkDto)
  @ApiStandardErrors()
  async logout(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(user, meta);
    res.clearCookie(RT_COOKIE, { path: '/auth' });
    return { ok: true };
  }

  @Public()
  @authLimit()
  @Post('forgot-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Email a password-reset link (always returns ok)' })
  @ApiEnvelope(OkDto)
  @ApiStandardErrors({ auth: false })
  async forgot(@Body() dto: ForgotPasswordDto, @ReqMeta() meta: RequestMeta) {
    await this.auth.forgotPassword(dto, meta);
    return { ok: true };
  }

  @Public()
  @authLimit()
  @Post('reset-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Set a new password with a reset/invite token; signs out every session' })
  @ApiEnvelope(OkDto)
  @ApiStandardErrors({ auth: false })
  async reset(@Body() dto: ResetPasswordDto, @ReqMeta() meta: RequestMeta) {
    await this.auth.resetPassword(dto, meta);
    return { ok: true };
  }

  @authLimit()
  @Post('change-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Change your own password. Needs the current password; ends every other login of this account' })
  @ApiEnvelope(OkDto)
  @ApiStandardErrors()
  async changePassword(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Body() dto: ChangePasswordDto) {
    await this.auth.changePassword(user, dto, meta);
    return { ok: true };
  }

  @AllowInactiveOrg()
  @Get('me')
  @ApiOperation({ summary: 'The signed-in user' })
  @ApiEnvelope(UserDto)
  @ApiStandardErrors()
  me(@CurrentUser() user: AuthUser) {
    return this.users.me(user.userId);
  }

  /** Browsers get the refresh token as an httpOnly cookie scoped to /auth; API clients use the body. */
  private withCookie(res: Response, tokens: IssuedTokens) {
    res.cookie(RT_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure: this.config.get('env', { infer: true }) === 'production',
      sameSite: 'strict',
      path: '/auth',
      maxAge: this.config.get('jwt', { infer: true }).refreshTtlDays * 86_400_000,
    });
    return tokens;
  }
}
