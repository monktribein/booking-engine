import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './common/app-setup';
import { JsonLogger, useJsonLogs } from './common/json-logger';
import type { AppConfig } from './config/configuration';

async function bootstrap() {
  // bodyParser:false + rawBody:true: parsers are registered by configureApp (in a fixed order)
  // and req.rawBody is kept for webhook signature verification.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, rawBody: true, bufferLogs: true });
  if (useJsonLogs()) app.useLogger(new JsonLogger('tirvona-api'));
  configureApp(app);
  const config = app.get(ConfigService<AppConfig, true>);
  const port = config.get('port', { infer: true });
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`Tirvona API listening on :${port} (queue=${config.get('queue', { infer: true }).driver}, workers=${config.get('queue', { infer: true }).workersEnabled})`);
}

void bootstrap();
