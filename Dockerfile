# ---- build ------------------------------------------------------------------
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

# The source goes in before `npm ci`: its postinstall runs the build
# (prisma generate + tsc), and Prisma's engines download during install.
COPY . .
RUN npm ci && npm prune --omit=dev --ignore-scripts

# ---- runtime ----------------------------------------------------------------
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl curl && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/dist ./dist
# Receipt PDFs embed these fonts (src/lib/receipt.ts).
COPY --from=build /app/assets ./assets

# Avatars and poll images are written here; mount a volume so they survive redeploys.
RUN mkdir -p uploads/avatars uploads/polls && chown -R node:node uploads
VOLUME ["/app/uploads"]

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1

# Apply any pending migrations, then start. `migrate deploy` is a no-op when
# the database is already up to date.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
