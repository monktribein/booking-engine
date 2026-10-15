# Tirvona frontend (Next.js 16, standalone output). Build from this directory:
#   docker build --build-arg NEXT_PUBLIC_API_URL=https://api.example.com -t tirvona-frontend ./frontend
#
# Only PUBLIC values are build arguments: NEXT_PUBLIC_* is compiled into browser JavaScript and visible to every visitor.
# Nothing secret is needed to build or run this image; do not add any (no JWT/Razorpay/database values).

# ---- dependencies (reproducible: npm ci from the lockfile) ---------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build ---------------------------------------------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_APP_URL
# Fail the build early instead of shipping a bundle that points at the wrong API.
RUN test -n "$NEXT_PUBLIC_API_URL" || (echo "build arg NEXT_PUBLIC_API_URL is required" && exit 1)
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runtime -------------------------------------------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache tini
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# standalone = server.js + only the node_modules it needs; static assets and public/ are copied next to it
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
# Liveness only (does not depend on the API). The server also refuses to start on an unsafe production configuration
# (instrumentation.ts), in which case the container exits and this check never goes healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
