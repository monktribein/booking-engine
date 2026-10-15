import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JsonLogger, useJsonLogs } from './common/json-logger';

/**
 * Worker process: the same modular monolith without an HTTP listener.
 * It consumes the BullMQ queues and runs the scheduler. Scale it
 * independently of the API (docker-compose service `worker`).
 */
async function bootstrap() {
  process.env.WORKERS_ENABLED = 'true';
  process.env.SCHEDULER_ENABLED ??= 'true';
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  if (useJsonLogs()) app.useLogger(new JsonLogger('tirvona-worker'));
  app.enableShutdownHooks();
  new Logger('Worker').log('Tirvona worker started (queues + scheduler)');
}

void bootstrap();
