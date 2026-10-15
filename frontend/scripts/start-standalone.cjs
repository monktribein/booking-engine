/**
 * Starts the production server from the standalone build (what the Docker image runs), for local production-mode runs and
 * the Playwright suite. `next start` is not supported with `output: "standalone"`.
 *
 *   NEXT_PUBLIC_API_URL=https://api.example.com npm run build     (public value, compiled into the bundle)
 *   npm start                                                     (PORT defaults to 3001)
 *
 * For a plain-http API on localhost set ALLOW_INSECURE_API_URL=true; production startup validation refuses http otherwise.
 */
const { cpSync, existsSync } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const dist = process.env.NEXT_DIST_DIR || '.next'; // must match the value used for the build
const standalone = path.join(root, dist, 'standalone');
if (!existsSync(path.join(standalone, 'server.js'))) {
  console.error('No standalone build found. Run `npm run build` first.');
  process.exit(1);
}
// The standalone folder deliberately omits static assets and public/ (a CDN normally serves them): copy them next to server.js.
cpSync(path.join(root, dist, 'static'), path.join(standalone, dist, 'static'), { recursive: true });
if (existsSync(path.join(root, 'public'))) cpSync(path.join(root, 'public'), path.join(standalone, 'public'), { recursive: true });

const child = spawn(process.execPath, ['server.js'], {
  cwd: standalone,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production', PORT: process.env.PORT ?? '3001', HOSTNAME: process.env.HOSTNAME ?? '0.0.0.0' },
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 1));
