import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import type { AppConfig } from '../../config/configuration';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Global()
@Module({
  imports: [
    UsersModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const jwt = config.get('jwt', { infer: true });
        return {
          secret: jwt.secret,
          signOptions: { algorithm: 'HS256', expiresIn: jwt.accessTtlSeconds, issuer: jwt.issuer, audience: jwt.audience },
          verifyOptions: { algorithms: ['HS256'], issuer: jwt.issuer, audience: jwt.audience },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [JwtModule, AuthService],
})
export class AuthModule {}
