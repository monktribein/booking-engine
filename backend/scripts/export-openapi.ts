/**
 * Writes the public API contract to docs/openapi-v1.json (or the path given as the first argument).
 * Boots the real app without connecting to anything: the database pool is lazy and the URL below points nowhere, so no
 * external service or credential is touched.
 *
 * Runs from the compiled output (Nest's DI needs decorator metadata, which tsx does not emit), so the npm scripts build first.
 *   npm run openapi:export            regenerate docs/openapi-v1.json
 *   npm run openapi:check             fail if the committed file differs from the code (CI)
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Deterministic output: object keys sorted, so a diff only shows real contract changes. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}

async function main() {
  const check = process.argv.includes('--check');
  const out = path.resolve(process.argv.find((a) => a.endsWith('.json')) ?? path.join(process.cwd(), '..', 'docs', 'openapi-v1.json'));
  {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://openapi:openapi@127.0.0.1:1/openapi_export',
      DATABASE_SSL: 'disable',
      QUEUE_DRIVER: 'inline',
      WORKERS_ENABLED: 'false',
      SCHEDULER_ENABLED: 'false',
      JWT_SECRET: randomBytes(32).toString('hex'),
      JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
      ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      SWAGGER_ENABLED: 'true',
      LOG_LEVEL: 'error',
    });
    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = await import('../src/app.module');
    const { configureApp, createApiDocuments } = await import('../src/common/app-setup');
    const app = await NestFactory.create<import('@nestjs/platform-express').NestExpressApplication>(AppModule, { bodyParser: false, rawBody: true, logger: ['error'], abortOnError: false });
    configureApp(app);
    await app.init();
    const text = JSON.stringify(sortKeys(createApiDocuments(app).v1), null, 2) + '\n';
    await app.close();

    if (check) {
      const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
      if (current.replace(/\r\n/g, '\n') !== text) {
        console.error(`${out} is out of date. Run "npm run openapi:export" and review the contract change (see docs/PUBLIC_API.md, versioning).`);
        process.exitCode = 1;
        return;
      }
      console.log('OpenAPI contract is up to date.');
    } else {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, text);
      console.log(`Wrote ${out}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
