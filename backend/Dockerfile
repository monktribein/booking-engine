# ---- build ---------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

# ---- runtime -------------------------------------------------------------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# Same image for API and worker; the worker service overrides the command.
CMD ["node", "dist/src/main.js"]
