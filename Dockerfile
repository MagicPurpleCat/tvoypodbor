# Один контейнер: API + бот + фоновые задачи + Mini App (статика).
# Используется на Amvera (amvera.yml) и подходит для любого хостинга с Dockerfile.
# При старте сам накатывает миграции БД.

FROM node:22-alpine AS webapp
WORKDIR /app/webapp
COPY webapp/package*.json ./
RUN npm ci
COPY webapp/ ./
COPY shared /app/shared
RUN npm run build

FROM node:22-alpine AS backend
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production PORT=3000
WORKDIR /app/backend
COPY --from=backend /app/backend/node_modules ./node_modules
COPY --from=backend /app/backend/dist ./dist
COPY backend/migrations ./migrations
COPY backend/package.json ./
COPY --from=webapp /app/webapp/dist /app/webapp/dist
COPY shared /app/shared
COPY assets/miniapp-cover.png /app/assets/miniapp-cover.png
USER node
EXPOSE 3000
CMD ["sh", "-c", "node dist/migrate.js && node dist/index.js"]
