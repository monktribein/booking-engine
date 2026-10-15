/**
 * Fails when something that looks like a real credential would be committed. Run before the first commit and in CI:
 *   node scripts/check-secrets.cjs            scan the working tree (everything .gitignore would not exclude)
 *   node scripts/check-secrets.cjs --staged   scan only what is staged in Git
 *
 * It is deliberately simple (pattern based, no network). It complements, and does not replace, a dedicated scanner.
 * A deliberately fake fixture that trips a rule can be marked with a trailing `secret-scan:allow` comment on that line.
 */
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, readdirSync, statSync } = require('node:fs');
const path = require('node:path');

// The repository root (backend/ and frontend/ and sdk/ and docs/ are all scanned), not just backend/.
const root = path.resolve(__dirname, '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'out', 'build', 'coverage', 'test-results', 'playwright-report', '.git']);
const SKIP_FILES = /(package-lock\.json|\.(png|jpe?g|gif|ico|svg|webp|woff2?|ttf|zip|pdf|tsbuildinfo))$/i;
const IGNORED_ENV = /(^|\/)\.env(\.(?!example$)[^/]+)?$/; // .env, .env.local ... (not .env.example)

const RULES = [
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['Razorpay LIVE key', /\brzp_live_[A-Za-z0-9]{8,}/],
  ['Stripe live key', /\bsk_live_[A-Za-z0-9]{16,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['database URL with a password', /\bmongodb(?:\+srv)?:\/\/[^\s"'<>@/:]+:(?!pass\b|password\b|\*+)[^\s"'<>@/]{4,}@(?!host\b)/],
  ['PostgreSQL URL with a password', /\bpostgres(?:ql)?:\/\/[^\s"'<>@/:]+:(?!pass\b|password\b|\*+|\$|%|\[YOUR-PASSWORD\])[^\s"'<>@/]{4,}@(?!host\b|127\.0\.0\.1|localhost|\[::1\])/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\b/],
  ['hard-coded secret assignment', /\b(?:JWT_SECRET|JWT_REFRESH_SECRET|ENCRYPTION_KEY|RAZORPAY_KEY_SECRET|RAZORPAY_WEBHOOK_SECRET)\s*=\s*(?!\s*$)(?!change-me|your-|<|\$\{|CHANGE)[^\s#]{12,}/],
];

function trackedOrWorkingFiles(staged) {
  if (staged) {
    return execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  }
  const out = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const p = path.join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  })(root);
  return out;
}

const staged = process.argv.includes('--staged');
if (staged && !existsSync(path.join(root, '.git'))) {
  console.error('Not a Git repository: nothing is staged. Run without --staged to scan the working tree.');
  process.exit(2);
}

const findings = [];
for (const rel of trackedOrWorkingFiles(staged)) {
  if (SKIP_FILES.test(rel)) continue;
  if (IGNORED_ENV.test(rel)) {
    if (staged) findings.push(`${rel}: environment file is staged (it must stay untracked)`);
    continue; // in a working-tree scan, local env files are expected and Git-ignored
  }
  const file = path.join(root, rel);
  if (!existsSync(file) || statSync(file).size > 2_000_000) continue;
  const text = readFileSync(file, 'utf8');
  if (text.includes('\u0000')) continue;
  const lines = text.split('\n');
  for (const [name, re] of RULES) {
    lines.forEach((line, i) => {
      if (re.test(line) && !line.includes('secret-scan:allow')) findings.push(`${rel}:${i + 1}: ${name}`);
    });
  }
}

if (findings.length) {
  console.error(`Possible secrets found (${findings.length}):\n - ${findings.join('\n - ')}`);
  process.exit(1);
}
console.log(`No secrets detected (${staged ? 'staged files' : 'working tree'}).`);
