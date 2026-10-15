import path from "node:path";
import type { NextConfig } from "next";

// Fail closed: a production build must never carry the demo flag (see lib/config.ts). The same rule is enforced again when
// the server starts (instrumentation.ts).
if (process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_DEMO_MODE?.trim().toLowerCase() === "true") {
  throw new Error("NEXT_PUBLIC_DEMO_MODE=true is not allowed in a production build. Unset it and redeploy.");
}

// NEXT_PUBLIC_* values are inlined into browser JavaScript. Only the public API base URL, the public site URL and the demo
// flag belong here. Server-only settings (API_INTERNAL_URL, ALLOW_INSECURE_API_URL) are read at runtime and never reach the browser.
const nextConfig: NextConfig = {
  // Minimal self-contained server for the Docker image (.next/standalone/server.js).
  output: "standalone",
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
        ],
      },
    ];
  },
};

export default nextConfig;
