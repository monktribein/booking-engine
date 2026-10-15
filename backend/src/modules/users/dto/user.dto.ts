import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsOptional, IsString, Length, Matches } from 'class-validator';
import { PropertyUserRole, UserRole, UserStatus } from '../../../database/enums';

export class UserDto {
  @ApiProperty() _id!: string;
  @ApiProperty({ nullable: true }) organizationId!: string | null;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiPropertyOptional() phone?: string;
  @ApiProperty({ enum: UserRole }) role!: UserRole;
  @ApiProperty({ enum: UserStatus }) status!: UserStatus;
  @ApiPropertyOptional() lastLoginAt?: string;
  @ApiProperty() createdAt!: string;
}

export class PropertyStaffDto {
  @ApiProperty() userId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: PropertyUserRole }) role!: PropertyUserRole;
  @ApiProperty({ enum: UserStatus }) status!: UserStatus;
}

export class AddStaffDto {
  @ApiProperty() @IsEmail() email!: string;
  @ApiProperty() @IsString() @Length(1, 120) name!: string;
  @ApiProperty({ enum: [PropertyUserRole.PROPERTY_MANAGER, PropertyUserRole.STAFF, PropertyUserRole.RECEPTION] })
  @IsEnum([PropertyUserRole.PROPERTY_MANAGER, PropertyUserRole.STAFF, PropertyUserRole.RECEPTION])
  role!: PropertyUserRole;
  @ApiPropertyOptional({ example: '+919800000003' })
  @IsOptional()
  @Matches(/^\+[1-9]\d{6,14}$/, { message: 'phone must be E.164' })
  phone?: string;
}

export class UpdateMeDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 120) name?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\+[1-9]\d{6,14}$/, { message: 'phone must be E.164' }) phone?: string;
}
