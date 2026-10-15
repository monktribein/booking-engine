import path from "node:path";
import type { NextConfig } from "next";

// Fail closed: a production build must never carry the demo flag (see lib/config.ts). The same rule is enforced again when
// the server starts (instrumentation.ts).
if (process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_DEMO_MODE?.trim().toLowerCase() === "true") {
  throw new Error("NEXT_PUBLIC_DEMO_MODE=true is not allowed in a production build. Unset it and redeploy.");
}

// NEXT_PUBLIC_* values are inlined into browser JavaScript. Only the public API base URL, the public site URL and the demo
// flag belong here. Server-only settings (API_INTERNAL_URL, ALLOW_INSECURE_API_URL) are read at runtime and never reach the browser.
// Content-Security-Policy (production builds only: the dev server needs eval and websockets). The API origin is the same public
// value that is compiled into the bundle, so the policy can only ever allow the API the app was built for. Razorpay Checkout
// needs its script and a frame; 'unsafe-inline' for scripts/styles is required by Next.js's inline bootstrap and Tailwind unless
// per-request nonces are introduced (documented in docs/PRODUCTION_AUDIT.md). Everything else is locked down.
function apiOrigin(): string {
  try {
    return new URL(process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000").origin;
  } catch {
    return "";
  }
}
const isHttpsApi = apiOrigin().startsWith("https://");
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://checkout.razorpay.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self' ${apiOrigin()} https://*.razorpay.com`.trim(),
  "frame-src https://api.razorpay.com https://checkout.razorpay.com",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  ...(isHttpsApi ? ["upgrade-insecure-requests"] : []),
].join("; ");

const nextConfig: NextConfig = {
  // Minimal self-contained server for the Docker image (.next/standalone/server.js).
  output: "standalone",
  // Build output folder. Defaults to .next; set NEXT_DIST_DIR to build somewhere else (e.g. so a browser-test build never
  // overwrites the .next folder a running `next dev` is using).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The frontend is its own project even though the repo root has a package-lock.json: trace from here so server.js
  // lands at the root of the standalone folder.
  outputFileTracingRoot: path.join(__dirname),
  turbopack: { root: path.join(__dirname) },
  poweredByHeader: false,
  // Production source maps are not shipped to browsers (they would expose original source).
  productionBrowserSourceMaps: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          ...(process.env.NODE_ENV === "production"
            ? [
                { key: "Content-Security-Policy", value: contentSecurityPolicy },
                // Meaningful over HTTPS only (browsers ignore it on plain http), so it is safe to send for local production runs too.
                { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
              ]
            : []),
        ],
      },
    ];
  },
};

export default nextConfig;
