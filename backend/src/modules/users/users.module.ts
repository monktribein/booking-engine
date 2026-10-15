import { Module } from '@nestjs/common';
import { PasswordResetService } from './password-reset.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, PasswordResetService],
  exports: [UsersService, PasswordResetService],
})
export class UsersModule {}
