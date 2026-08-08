#!/usr/bin/env bash
#
# .env (로컬 실행용) → .env.deploy (도커 실행용) 생성 스크립트.
#
#   ./scripts/env-deploy.sh           .env.deploy 생성/갱신
#   ./scripts/env-deploy.sh check     .env.deploy 가 최신인지 확인 (쓰지 않음)
#
# 왜 생성하는가:
#   두 파일이 다른 것은 경로 네 개뿐이고 나머지는 전부 같은 시크릿이다.
#   손으로 복제하면 키를 갱신할 때 한쪽만 바뀌어 조용히 어긋난다. 그래서
#   .env 를 유일한 원본으로 두고 도커용은 매번 파생시킨다.
#
# 무엇이 달라지는가 (cwd 가 로컬은 server/, 컨테이너는 /app 이라서):
#   APPS_CONFIG_PATH   ../config/apps.json      → /app/config/apps.json
#   VPN_OVPN_CONFIG    ../config/production.ovpn → /app/config/production.ovpn
#   AKITA_QUERY_CLI    ../../akita_schema/...   → 제거 (Dockerfile 이 잡아둔 값 사용)
#   NODE_ENV           development              → production
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

SRC="$ROOT/.env"
OUT="$ROOT/.env.deploy"

# 컨테이너 안에서 config/ 가 마운트되는 위치 (docker-compose.yml 의 volumes 와 일치).
CONTAINER_CONFIG="/app/config"

ACTION="${1:-sync}"

log()  { echo "[env-deploy] $*"; }
fail() { echo "[env-deploy] 오류: $*" >&2; exit 1; }

[ -f "$SRC" ] || fail "$SRC 가 없습니다. .env.example 을 복사해 값을 채우세요."

# ── 변환 ─────────────────────────────────────────────────────
# 값에 '!' 나 '$' 같은 문자가 들어있어도(DB 비밀번호) 셸이 해석하지 않도록
# source 하지 않고 줄 단위로 그대로 옮긴다.
render() {
    cat <<EOF
# ─────────────────────────────────────────────────────────────
# 자동 생성 파일 — 직접 고치지 마세요.
#
#   생성: ./scripts/env-deploy.sh   (원본: .env)
#   쓰임: docker-compose.yml 의 env_file
#
# 값을 바꾸려면 .env 를 고친 뒤 이 스크립트를 다시 돌리세요.
# ─────────────────────────────────────────────────────────────
EOF

    awk -v cfg="$CONTAINER_CONFIG" '
        # 생성물이므로 원본 주석·빈 줄은 옮기지 않는다 (설명은 .env.example 에 있다).
        /^[[:space:]]*#/  { next }
        /^[[:space:]]*$/  { next }
        {
            eq = index($0, "=")
            if (eq == 0) next
            key = substr($0, 1, eq - 1)
            val = substr($0, eq + 1)

            # 컨테이너는 /app 에서 돌고 config/ 가 통째로 마운트된다.
            if (key == "APPS_CONFIG_PATH") {
                print "APPS_CONFIG_PATH=" cfg "/apps.json"
                next
            }
            if (key == "VPN_OVPN_CONFIG") {
                n = split(val, parts, "/")
                print "# .ovpn 은 config/ 마운트를 통해 들어옵니다."
                print "VPN_OVPN_CONFIG=" cfg "/" parts[n]
                next
            }

            # env_file 은 이미지 ENV 를 덮어쓴다. 여기서 값을 주면
            # Dockerfile 이 잡아둔 /app/akita/... 를 가리고 질의 앱이 깨진다.
            if (key == "AKITA_QUERY_CLI") {
                print "# AKITA_QUERY_CLI 는 Dockerfile 이 설정합니다 — 여기서 덮어쓰지 않습니다."
                next
            }

            if (key == "NODE_ENV") { print "NODE_ENV=production"; next }

            print key "=" val
        }
    ' "$SRC"
}

# ── 확인 ─────────────────────────────────────────────────────
# 값이 없으면 컨테이너가 뜨긴 하지만 해당 앱만 조용히 실패한다. 미리 짚어준다.
warn_missing() {
    local file="$1" key value
    for key in OPENAI_API_KEY WORKSPACE_ID DATABASE_URL; do
        value="$(awk -v k="$key" 'index($0, k "=") == 1 { print substr($0, length(k) + 2) }' "$file")"
        [ -n "$value" ] || log "⚠️  $key 가 비어 있습니다 — 관련 앱이 동작하지 않습니다."
    done

    value="$(awk 'index($0, "VPN_OVPN_CONFIG=") == 1 { print substr($0, 17) }' "$file")"
    if [ -n "$value" ]; then
        local host_file="$ROOT/config/${value##*/}"
        [ -f "$host_file" ] || log "⚠️  $host_file 이 없습니다 — VPN 기능이 꺼진 채로 뜹니다."
    fi
}

case "$ACTION" in
    sync)
        render > "$OUT.tmp"
        chmod 600 "$OUT.tmp"          # 시크릿이 들어있다
        mv "$OUT.tmp" "$OUT"
        log "생성: $OUT  (원본: $SRC)"
        warn_missing "$OUT"
        ;;
    check)
        [ -f "$OUT" ] || fail "$OUT 가 없습니다. './scripts/env-deploy.sh' 를 먼저 실행하세요."
        if diff -q <(render) "$OUT" >/dev/null 2>&1; then
            log "최신 상태입니다: $OUT"
        else
            fail "$OUT 가 .env 와 어긋났습니다. './scripts/env-deploy.sh' 로 다시 생성하세요."
        fi
        ;;
    *)
        fail "알 수 없는 동작: $ACTION (sync|check)"
        ;;
esac
