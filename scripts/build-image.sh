#!/usr/bin/env bash
#
# AI Hub 도커 이미지 빌드·배포 스크립트.
#
#   ./scripts/build-image.sh build      이미지 빌드
#   ./scripts/build-image.sh verify     빌드된 이미지를 띄워 동작 확인
#   ./scripts/build-image.sh push       ECR 로그인 후 push
#   ./scripts/build-image.sh release    build → verify → push
#
# 환경변수로 조정합니다 (기본값은 아래 참고):
#   PLATFORM        빌드 대상 아키텍처 (기본 linux/amd64)
#   AKITA_CONTEXT   akita_schema 경로 (기본 ../akita_schema)
#   IMAGE / TAG     이미지 이름·태그
#   REGISTRY        ECR 레지스트리 (push 에 필요)
#   AWS_REGION      ECR 로그인 리전
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

# 이 맥은 arm64 지만 AWS 는 대개 x86_64 다. 기본값을 amd64 로 두어
# "로컬에선 되는데 ECS 에서 exec format error" 를 처음부터 막는다.
# Graviton 인스턴스라면 PLATFORM=linux/arm64 로 덮어쓴다.
PLATFORM="${PLATFORM:-linux/amd64}"
AKITA_CONTEXT="${AKITA_CONTEXT:-$ROOT/../akita_schema}"
IMAGE="${IMAGE:-aihub}"
TAG="${TAG:-$(date +%Y%m%d-%H%M)}"
REGISTRY="${REGISTRY:-}"
AWS_REGION="${AWS_REGION:-ap-northeast-2}"

ACTION="${1:-build}"

log()  { echo "[build-image] $*"; }
fail() { echo "[build-image] 오류: $*" >&2; exit 1; }

# ── 사전 확인 ────────────────────────────────────────────────
# 질의 생성기 소스는 별도 저장소에 있고 빌드 시점에만 필요하다. 없으면 도커가
# 'akita:latest 를 pull 할 수 없다' 는 엉뚱한 메시지를 내므로 먼저 짚어준다.
check_context() {
    [ -d "$AKITA_CONTEXT" ] || fail \
        "akita_schema 를 찾을 수 없습니다: $AKITA_CONTEXT
  질의 생성기 소스가 빌드 시점에 필요합니다. 형제 디렉터리에 클론하거나
  AKITA_CONTEXT 로 경로를 지정하세요."

    for required in "src/ai/cli/query-cli.ts" "docs/ai-schema/entities.json" "package-lock.json"; do
        [ -e "$AKITA_CONTEXT/$required" ] || fail \
            "$AKITA_CONTEXT 에 $required 가 없습니다.
  스키마 카탈로그가 비어 있다면 akita_schema 에서 'npm run generate' 를 먼저 실행하세요."
    done
}

full_name() {
    if [ -n "$REGISTRY" ]; then
        echo "${REGISTRY}/${IMAGE}:${TAG}"
    else
        echo "${IMAGE}:${TAG}"
    fi
}

do_build() {
    check_context
    local name
    name="$(full_name)"

    log "빌드: $name  (platform=$PLATFORM)"
    log "akita_schema: $AKITA_CONTEXT"
    if [ "$PLATFORM" != "linux/$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')" ]; then
        log "⚠️  현재 머신과 다른 아키텍처입니다. 에뮬레이션이라 몇 분 더 걸립니다."
    fi

    docker build \
        --platform "$PLATFORM" \
        --build-context "akita=$AKITA_CONTEXT" \
        -t "$name" \
        -t "${IMAGE}:latest" \
        "$ROOT"

    log "완료: $name"
}

# 이미지가 실제로 뜨고 질의 생성기까지 붙는지 확인한다. 볼륨 없이 띄워서
# 이미지 하나로 자족적인지도 같이 본다.
# 컨테이너 이름은 전역이어야 한다 — EXIT 트랩은 함수가 반환된 뒤에 돌기 때문에
# local 로 두면 그 시점엔 값이 비어 정리가 조용히 실패한다.
VERIFY_CONTAINER=""

do_verify() {
    local name
    name="$(full_name)"
    VERIFY_CONTAINER="aihub-verify-$$"

    log "검증: $name (볼륨 없이 기동)"
    docker rm -f "$VERIFY_CONTAINER" >/dev/null 2>&1 || true
    docker run -d --name "$VERIFY_CONTAINER" \
        --platform "$PLATFORM" \
        -e OPENAI_API_KEY=sk-verify \
        -e WORKSPACE_ID=0 \
        -e LLM_MODEL=gpt-5-mini \
        "$name" >/dev/null

    trap 'docker rm -f "$VERIFY_CONTAINER" >/dev/null 2>&1 || true' EXIT

    local health=""
    for _ in $(seq 1 20); do
        health="$(docker exec "$VERIFY_CONTAINER" wget -qO- http://127.0.0.1:3000/api/health 2>/dev/null || true)"
        [ -n "$health" ] && break
        sleep 1
    done
    [ -n "$health" ] || fail "컨테이너가 기동하지 않았습니다. docker logs $VERIFY_CONTAINER 를 확인하세요."
    log "health: $health"

    # 질의 생성기가 이미지 안에서 실제로 동작하는지 본다.
    docker cp "$HERE/verify-query.mjs" "$VERIFY_CONTAINER:/tmp/verify-query.mjs" >/dev/null
    docker exec "$VERIFY_CONTAINER" node /tmp/verify-query.mjs

    log "검증 통과"
}

do_push() {
    [ -n "$REGISTRY" ] || fail "REGISTRY 가 필요합니다. 예: REGISTRY=<계정>.dkr.ecr.${AWS_REGION}.amazonaws.com"
    command -v aws >/dev/null || fail "aws CLI 가 필요합니다 (ECR 로그인)."

    local name
    name="$(full_name)"
    docker image inspect "$name" >/dev/null 2>&1 || fail "이미지가 없습니다: $name — 먼저 build 하세요."

    log "ECR 로그인: $REGISTRY"
    aws ecr get-login-password --region "$AWS_REGION" \
        | docker login --username AWS --password-stdin "$REGISTRY"

    log "push: $name"
    docker push "$name"
    log "완료: $name"
}

case "$ACTION" in
    build)   do_build ;;
    verify)  do_verify ;;
    push)    do_push ;;
    release) do_build; do_verify; do_push ;;
    *)       fail "알 수 없는 동작: $ACTION (build|verify|push|release)" ;;
esac
