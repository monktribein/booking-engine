import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsMongoId, IsOptional, Matches, Max, Min } from 'class-validator';

export const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const IsDateOnly = () => Matches(DATE_ONLY_PATTERN, { message: '$property must be a date in YYYY-MM-DD format' });

export class PaginationQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}

export class PropertyScopedPageQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: 'Property the results belong to (access is checked)' })
  @IsMongoId()
  propertyId!: string;
}

export class DateRangeQueryDto {
  @ApiProperty({ example: '2026-10-01' }) @IsDateOnly() from!: string;
  @ApiProperty({ example: '2026-10-15', description: 'Exclusive' }) @IsDateOnly() to!: string;
}
