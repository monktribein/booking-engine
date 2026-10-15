/**
 * Runs the backend e2e suites on REAL BullMQ + Redis.
 *
 *   TEST_REDIS_URL=redis://127.0.0.1:6390 npm run test:bullmq         use an isolated development Redis you started
 *   REDIS_SERVER_BIN=/path/to/redis-server npm run test:bullmq         let this script start (and stop) its own throw-away Redis
 *   npm run test:bullmq -- test/payments                               extra arguments go to jest
 *
 * Safety: only loopback Redis hosts are accepted by the test harness, each test app uses a unique key prefix and deletes
 * only its own keys, FLUSHDB/FLUSHALL are never issued. Production Redis must never be used.
 */
const { spawn } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const net = require('node:net');
const { tmpdir } = require('node:os');
const path = require('node:path');

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

async function waitForPort(port, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise((resolve) => {
      const c = net.connect(port, '127.0.0.1', () => {
        c.destroy();
        resolve(true);
      });
      c.on('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('redis did not start');
}

(async () => {
  let url = process.env.TEST_REDIS_URL;
  let own = null;
  const bin = process.env.REDIS_SERVER_BIN || process.env.TEST_REDIS_BIN;
  if (!url) {
    if (!bin) {
      console.error('No Redis available: set TEST_REDIS_URL (an isolated dev Redis) or REDIS_SERVER_BIN (path to redis-server).');
      process.exit(2);
    }
    const port = await freePort();
    own = spawn(bin, ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--maxmemory-policy', 'noeviction'], {
      cwd: mkdtempSync(path.join(tmpdir(), 'tirvona-redis-')),
      stdio: 'ignore',
    });
    await waitForPort(port);
    url = `redis://127.0.0.1:${port}`;
    console.log(`started throw-away Redis on ${url}`);
  }
  const jest = spawn(process.execPath, [require.resolve('jest/bin/jest'), '--forceExit', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, TEST_QUEUE_DRIVER: 'bullmq', TEST_REDIS_URL: url, ...(bin ? { TEST_REDIS_BIN: bin } : {}) },
  });
  jest.on('exit', (code) => {
    if (own) own.kill();
    process.exit(code ?? 1);
  });
})();
