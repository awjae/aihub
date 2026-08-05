# ─────────────────────────────────────────────────────────────
# 프론트(React) + 서버(NestJS)를 하나의 이미지로 패키징한다.
# 런타임에는 /app/dist(서버) 가 /app/public(프론트 빌드 결과)을 정적 서빙한다.
# ─────────────────────────────────────────────────────────────

# ── 1) 프론트 빌드 ────────────────────────────────────────────
FROM node:22-alpine AS web-builder
WORKDIR /build/web

COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./
RUN npm run build

# ── 2) 서버 빌드 ──────────────────────────────────────────────
FROM node:22-alpine AS server-builder
WORKDIR /build/server

COPY server/package.json server/package-lock.json ./
RUN npm ci

COPY server/ ./
RUN npm run build

# ── 3) 프로덕션 의존성만 별도 설치 ────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /build/server

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── 4) 런타임 ─────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    APPS_CONFIG_PATH=/app/config/apps.json \
    MCP_CONFIG_PATH=/app/config/mcp.json

COPY --from=deps          /build/server/node_modules ./node_modules
COPY --from=server-builder /build/server/dist        ./dist
COPY --from=web-builder    /build/web/dist           ./public
COPY server/package.json ./package.json

# 설정 파일은 이미지에 기본값을 굽되, 배포 시 볼륨으로 덮어쓸 수 있게 한다.
COPY config/ ./config/

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" > /dev/null || exit 1

CMD ["node", "dist/main.js"]
