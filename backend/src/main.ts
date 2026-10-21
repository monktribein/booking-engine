import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './common/app-setup';
import { JsonLogger, useJsonLogs } from './common/json-logger';
import type { AppConfig } from './config/configuration';

// Global error handlers for network disconnects / resets
process.on('uncaughtException', (err: any) => {
  if (err?.code === 'ECONNRESET' || err?.message?.includes('ECONNRESET')) {
    new Logger('Process').warn(`Handled socket disconnect (ECONNRESET): ${err.message}`);
    return;
  }
  new Logger('Process').error(`Uncaught exception: ${err?.stack || err}`);
  process.exit(1);
});

async function bootstrap() {
  // bodyParser:false + rawBody:true: parsers are registered by configureApp (in a fixed order)
  // and req.rawBody is kept for webhook signature verification.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, rawBody: true, bufferLogs: true });
  if (useJsonLogs()) app.useLogger(new JsonLogger('tirvona-api'));
  configureApp(app);
  const config = app.get(ConfigService<AppConfig, true>);
  const port = config.get('port', { infer: true });
  if (process.env.NODE_ENV === 'production' && !process.env.BFF_SHARED_SECRET) {
    // Not fatal (API-only deployments exist), but a web app in front of this API would share ONE login rate limit between all users.
    new Logger('Bootstrap').warn('BFF_SHARED_SECRET is unset: logins through the web app all appear to come from the web server, so they share one rate limit and audit logs show its address. Set the same 32+ character value on the API and the web app.');
  }
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`Tirvona API listening on :${port} (queue=${config.get('queue', { infer: true }).driver}, workers=${config.get('queue', { infer: true }).workersEnabled})`);
}

void bootstrap();
