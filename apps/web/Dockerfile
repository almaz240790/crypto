# apps/web — Next.js (standalone). Контекст сборки — корень репозитория.
# Раскладка как в монорепозитории: /repo/apps/web + /repo/packages/charts (file:-зависимость).
FROM node:22-alpine AS deps
WORKDIR /repo/apps/web
COPY packages/charts/package.json packages/charts/package-lock.json /repo/packages/charts/
RUN cd /repo/packages/charts && npm ci --omit=dev --no-audit --no-fund
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /repo/apps/web
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /repo/packages/charts/node_modules /repo/packages/charts/node_modules
COPY --from=deps /repo/apps/web/node_modules ./node_modules
COPY packages/charts /repo/packages/charts
COPY apps/web ./
RUN mkdir -p public && npm run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /repo/apps/web/.next/standalone ./
COPY --from=build --chown=app:app /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=app:app /repo/apps/web/public ./apps/web/public
USER app
EXPOSE 3000
CMD ["sh", "-c", "exec node apps/web/server.js -p ${PORT:-3000}"]
