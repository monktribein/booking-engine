import { Type, applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  ApiSecurity,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from '@nestjs/swagger';

export class ApiErrorDetailDto {
  @ApiProperty({ example: 'ROOM_NOT_AVAILABLE' }) code!: string;
  @ApiProperty({ example: 'The selected room is not available.' }) message!: string;
  @ApiPropertyOptional({ type: Object }) details?: Record<string, unknown>;
}

export class ApiErrorResponseDto {
  @ApiProperty({ example: false }) success!: false;
  @ApiProperty({ type: ApiErrorDetailDto }) error!: ApiErrorDetailDto;
}

export class PageMetaDto {
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
}

/**
 * Documents the { success: true, data } envelope around a response DTO.
 *   @ApiEnvelope(ReservationDto)                  → data: ReservationDto
 *   @ApiEnvelope(ReservationDto, { isArray: true })
 *   @ApiEnvelope(ReservationDto, { paginated: true }) → data: { items, page, limit, total }
 */
export function ApiEnvelope(
  model: Type<unknown>,
  opts: { status?: number; isArray?: boolean; paginated?: boolean; description?: string } = {},
) {
  const item = { $ref: getSchemaPath(model) };
  const data = opts.paginated
    ? { allOf: [{ $ref: getSchemaPath(PageMetaDto) }, { properties: { items: { type: 'array', items: item } } }] }
    : opts.isArray
      ? { type: 'array', items: item }
      : item;
  return applyDecorators(
    ApiExtraModels(model, PageMetaDto, ApiErrorResponseDto),
    ApiResponse({
      status: opts.status ?? 200,
      description: opts.description ?? 'Success',
      schema: { type: 'object', required: ['success', 'data'], properties: { success: { type: 'boolean', example: true }, data } },
    }),
  );
}

const err = (description: string) => ({ description, type: ApiErrorResponseDto });

/** Standard error responses for an authenticated endpoint. Add extra conflict/not-found codes as needed. */
export function ApiStandardErrors(opts: { auth?: boolean; keyAuth?: boolean; notFound?: boolean; conflict?: string } = {}) {
  const decorators = [
    ApiBadRequestResponse(err('VALIDATION_ERROR: the request body, query or path is invalid')),
    ApiTooManyRequestsResponse(err('RATE_LIMITED')),
  ];
  if (opts.keyAuth) {
    decorators.push(
      ApiSecurity('api-key'),
      ApiUnauthorizedResponse(err('API_KEY_MISSING / API_KEY_INVALID / API_KEY_REVOKED / API_KEY_EXPIRED')),
      ApiForbiddenResponse(err('API_SCOPE_MISSING: the key lacks the scope this endpoint needs')),
    );
  } else if (opts.auth !== false) {
    decorators.push(
      ApiBearerAuth(),
      ApiUnauthorizedResponse(err('UNAUTHORIZED / TOKEN_INVALID / SESSION_REVOKED')),
      ApiForbiddenResponse(err('FORBIDDEN: no access to this property, or the role lacks the permission')),
    );
  }
  if (opts.notFound) decorators.push(ApiNotFoundResponse(err('NOT_FOUND')));
  if (opts.conflict) decorators.push(ApiConflictResponse(err(opts.conflict)));
  return applyDecorators(...decorators);
}

/** Generic response model for endpoints that return a simple acknowledgement. */
export class OkDto {
  @ApiProperty({ example: true }) ok!: boolean;
}
