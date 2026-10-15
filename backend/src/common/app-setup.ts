import { ValidationError, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { AppConfig } from '../config/configuration';
import { buildPublicApiDocument } from './public-api-document';
import { DomainValidationError } from '../database/errors';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './interceptors/response-envelope.interceptor';
import { JsonLogger, requestLogger, useJsonLogs } from './json-logger';

function flatten(errors: ValidationError[], parent = ''): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const e of errors) {
    const path = parent ? `${parent}.${e.property}` : e.property;
    if (e.constraints) out[path] = Object.values(e.constraints);
    if (e.children?.length) Object.assign(out, flatten(e.children, path));
  }
  return out;
}

/**
 * Everything that makes an app instance "the Tirvona API". Shared by main.ts
 * and the e2e tests, so tests exercise the real security stack.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get(ConfigService<AppConfig, true>);

  app.set('trust proxy', 1); // behind one load balancer: req.ip is the client, used by rate limiting
  app.disable('x-powered-by');
  app.use(helmet());
  if (useJsonLogs() && process.env.LOG_REQUESTS !== 'false') app.use(requestLogger(new JsonLogger('tirvona-api')));
  app.use(cookieParser());
  // The app is created with bodyParser:false + rawBody:true, so parsers are registered here, in order,
  // before the validation pipe. Webhook signature checks read req.rawBody.
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { extended: false, limit: '100kb' });
  app.enableCors({
    origin: config.get('corsOrigins', { infer: true }),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) => new DomainValidationError('Request validation failed', { fields: flatten(errors) }),
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  app.enableShutdownHooks();

  if (config.get('swagger', { infer: true }).enabled) {
    SwaggerModule.setup('docs', app, () => createApiDocuments(app).full, { jsonDocumentUrl: 'docs/openapi.json' });
    // The stable, versioned contract for external integrators: only /v1 (plus the public payment confirmation call).
    SwaggerModule.setup('docs/v1', app, () => createApiDocuments(app).v1, { jsonDocumentUrl: 'docs/v1/openapi.json' });
  }
}

/** The complete API document and the public /v1 contract derived from it (also used by `npm run openapi:export`). */
export function createApiDocuments(app: NestExpressApplication) {
  const config = new DocumentBuilder()
    .setTitle('Tirvona API')
    .setDescription(
      'PMS, booking engine and channel manager. Every response is wrapped as `{ success, data }` or `{ success: false, error: { code, message } }`. Money is in minor units (paise).',
    )
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'API key (tvk_...)' }, 'api-key')
    .build();
  const full = SwaggerModule.createDocument(app, config);
  return { full, v1: buildPublicApiDocument(full) };
}
