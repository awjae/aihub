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

# ── 3-b) 질의 생성기(akita_schema) 의존성 ─────────────────────
# 소스는 별도 저장소(akita_schema)에 있고, named build context 'akita' 로 들어온다.
#   docker compose  → docker-compose.yml 의 additional_contexts
#   docker build    → --build-context akita=../akita_schema
FROM node:22-alpine AS akita-deps
WORKDIR /build/akita

COPY --from=akita package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── 4) 런타임 ─────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# Client VPN 제어용. VPC 밖에서 띄울 때만 실제로 쓰이며, 쓰려면 컨테이너에
# NET_ADMIN 과 /dev/net/tun 이 있어야 한다 (docker-compose.yml 참고).
# 설치만으로는 아무 권한도 늘지 않는다.
RUN apk add --no-cache openvpn

ENV NODE_ENV=production \
    PORT=3000 \
    APPS_CONFIG_PATH=/app/config/apps.json \
    AKITA_QUERY_CLI=/app/akita/src/ai/cli/query-cli.ts

COPY --from=deps          /build/server/node_modules ./node_modules
COPY --from=server-builder /build/server/dist        ./dist
COPY --from=web-builder    /build/web/dist           ./public
COPY server/package.json ./package.json

# 질문 → SQL 변환기. 게이트웨이가 질의마다 자식 프로세스로 띄운다.
# 빌드 단계가 없다 — node 가 TypeScript 소스를 그대로 실행한다(타입 스트리핑).
# 그래서 node_modules 밖에 두어야 한다: node 는 node_modules 안의 .ts 는 거부한다.
COPY --from=akita-deps /build/akita/node_modules ./akita/node_modules
COPY --from=akita package.json   ./akita/package.json
COPY --from=akita src            ./akita/src
COPY --from=akita docs/ai-schema ./akita/docs/ai-schema

# 설정 파일은 이미지에 기본값을 굽되, 배포 시 볼륨으로 덮어쓸 수 있게 한다.
COPY config/ ./config/

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" > /dev/null || exit 1

CMD ["node", "dist/main.js"]
