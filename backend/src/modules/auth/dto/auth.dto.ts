import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';
import { UserDto } from '../../users/dto/user.dto';

const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).+$/;
const PASSWORD_MSG = 'password must be 10-128 characters and contain a letter and a digit';

export class RegisterDto {
  @ApiProperty({ example: 'Asha Gupta' }) @IsString() @Length(1, 120) name!: string;
  @ApiProperty({ example: 'asha@example.com' }) @IsEmail() @MaxLength(254) email!: string;
  @ApiProperty({ minLength: 10, example: 'correct-horse-9' })
  @IsString()
  @MinLength(10)
  @MaxLength(128)
  @Matches(PASSWORD_RULE, { message: PASSWORD_MSG })
  password!: string;
  @ApiProperty({ example: 'Gupta Hospitality' }) @IsString() @Length(2, 160) organizationName!: string;
  @ApiPropertyOptional({ example: '+919800000001' })
  @IsOptional()
  @Matches(/^\+[1-9]\d{6,14}$/, { message: 'phone must be E.164' })
  phone?: string;
}

export class LoginDto {
  @ApiProperty() @IsEmail() @MaxLength(254) email!: string;
  @ApiProperty() @IsString() @Length(1, 128) password!: string;
}

export class RefreshDto {
  @ApiPropertyOptional({ description: 'Refresh token. May instead be sent in the httpOnly tirvona_rt cookie.' })
  @IsOptional()
  @IsString()
  @Length(20, 200)
  refreshToken?: string;
}

export class ForgotPasswordDto {
  @ApiProperty() @IsEmail() @MaxLength(254) email!: string;
}

export class ResetPasswordDto {
  @ApiProperty() @IsString() @Length(20, 200) token!: string;
  @ApiProperty({ minLength: 10 })
  @IsString()
  @MinLength(10)
  @MaxLength(128)
  @Matches(PASSWORD_RULE, { message: PASSWORD_MSG })
  newPassword!: string;
}

export class AuthTokensDto {
  @ApiProperty({ description: 'JWT, send as Authorization: Bearer <token>' }) accessToken!: string;
  @ApiProperty({ description: 'Opaque, single-use, rotated on every refresh' }) refreshToken!: string;
  @ApiProperty({ description: 'Access token lifetime in seconds' }) expiresIn!: number;
  @ApiProperty({ type: UserDto }) user!: UserDto;
}
