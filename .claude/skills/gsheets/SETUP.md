# Google Sheets 연동 최초 설정 가이드

처음 설정하는 사람을 위한 문서입니다. **한 번만 하면 이후 재인증이 없습니다.**
설정을 마치면 터미널을 쓸 수 있는 에이전트·에디터 어디서든 같은 CLI로 시트를 읽고 쓸 수 있습니다.

소요 시간: 약 5분. 필요한 것: Google 계정, Python 3.10+ (표준 라이브러리만 사용, 설치할 패키지 없음).

---

## 왜 MCP가 아니라 CLI인가

Google이 공식 MCP 서버(`sheetsmcp.googleapis.com`)를 제공하지만 **Claude Code·Cursor에 실질적으로 붙지 않습니다.** 시도하면 시간만 버립니다:

| 시도 | 결과 |
|------|------|
| `.mcp.json`에 URL만 등록 | `Incompatible auth server: does not support dynamic client registration` — Google은 DCR 미지원 |
| `--client-id`로 자체 클라이언트 지정 | 인증은 되지만 **refresh token이 발급되지 않음** → access token 1시간 만료 후 갱신 불가, 매시간 재인증 |
| claude.ai Google Drive 커넥터 | 읽기는 되지만 **탭 이름·셀 색상 소실, A1 범위 지정 불가** |

원인은 MCP 클라이언트의 범용 OAuth 플로우가 Google 전용 파라미터 `access_type=offline`을 보내지 않는 것입니다. `auth.py`는 그것을 명시해 refresh token을 받으므로 만료 문제가 없고, CLI라서 어떤 도구에서든 동작합니다.

---

## 1. Google Cloud 프로젝트 + Sheets API 활성화

1. https://console.cloud.google.com 접속
2. 상단에서 프로젝트 선택 → **새 프로젝트** (이름 예: `sheets-cli`)
3. **API 및 서비스 → 라이브러리** → `Google Sheets API` 검색 → **사용**

> ⚠️ 활성화할 것은 `Google Sheets API`입니다. `Sheets MCP API`(`sheetsmcp.googleapis.com`)는 이 CLI와 무관합니다.

## 2. OAuth 동의 화면 구성

1. **API 및 서비스 → OAuth 동의 화면**
2. User Type: 회사 Google Workspace 계정이면 **내부(Internal)**, 개인 계정이면 **외부(External)**
3. 앱 이름·지원 이메일 입력 후 저장
4. **외부(External)를 선택했다면** → **테스트 사용자**에 본인 Google 계정을 추가

> **Internal을 쓸 수 있으면 그게 낫습니다.** External + "테스트" 상태에서는 refresh token이 **7일 후 만료**되어 주기적으로 재인증해야 합니다. Internal은 만료 제한이 없습니다.

## 3. OAuth 클라이언트 ID 발급

1. **API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID**
2. 애플리케이션 유형: **웹 애플리케이션**
3. **승인된 리디렉션 URI**에 정확히 추가:
   ```
   http://localhost:8080/callback
   ```
4. 생성 후 **클라이언트 ID**와 **클라이언트 보안 비밀**을 복사

> 8080 포트가 이미 쓰이면 다른 포트를 등록하고 4단계에서 `--port`로 맞춰주세요. 리디렉션 URI와 `--port`는 **반드시 일치**해야 합니다.

## 4. 인증 실행

```bash
cd .claude/skills/gsheets

# 읽기 전용 (권장 — 조회만 필요한 경우)
GSHEETS_CLIENT_ID="...apps.googleusercontent.com" \
GSHEETS_CLIENT_SECRET="..." \
  python3 -u auth.py

# 읽기 + 쓰기
GSHEETS_CLIENT_ID="...apps.googleusercontent.com" \
GSHEETS_CLIENT_SECRET="..." \
  python3 -u auth.py --write
```

브라우저가 열립니다:

1. **읽으려는 시트가 공유된 계정**을 선택합니다 (다른 계정을 고르면 나중에 `The caller does not have permission`이 납니다)
2. External + 테스트 상태면 "확인되지 않은 앱" 경고 → **고급 → (안전하지 않음) 계속**
3. 권한 허용

성공하면 `✅ refresh token을 저장했습니다`가 출력됩니다.

> ⚠️ **`python3 -u`로 실행하세요.** 출력을 파이프하거나 `-u`를 빼면 버퍼링 때문에 인증 URL이 화면에 나오지 않습니다.

**저장 위치** — 저장소에는 아무 값도 남지 않습니다:
- macOS: 키체인 (service `gsheets-oauth`)
- 그 외 OS: `~/.config/gsheets/credentials.json` (권한 600)

## 5. 확인

```bash
python3 gsheets.py tabs "https://docs.google.com/spreadsheets/d/<시트ID>/edit"
```

탭 목록(gid·이름·크기)이 나오면 완료입니다.

---

## 사용법

```bash
# 읽기
python3 gsheets.py tabs   "<ID|URL>"                        # 탭 목록 (gid ↔ 탭 이름 매핑)
python3 gsheets.py values "<ID|URL>" "'탭 이름'!A1:Z100"      # A1 범위
python3 gsheets.py grid   "<ID|URL>" "'탭 이름'!A1:Z50"       # 값 + 배경색 hex
python3 gsheets.py dump   "<ID|URL>" --gid 745793729        # 탭 전체 TSV

# 쓰기 (--write 로 인증한 경우)
printf 'a\tb\nc\td\n' | python3 gsheets.py set    "<ID|URL>" "'탭'!A1:B2"
printf 'x\ty\n'       | python3 gsheets.py append "<ID|URL>" "'탭'"
python3 gsheets.py clear "<ID|URL>" "'탭'!A1:B2" --yes
```

- 탭 이름에 한글·공백·`/`가 있으면 **작은따옴표로 감싸세요**: `"'1차 / 2차 검증'!A1:Z50"`
- `--json`으로 집계용 출력
- 쓰기 입력은 **TSV**(탭 구분). 파일로 주려면 `--tsv 파일경로`

## 도구별 사용

CLI이므로 별도 연동이 필요 없습니다 — 각 도구의 터미널/셸 실행 기능으로 그대로 호출합니다.

| 도구 | 사용 방법 |
|------|-----------|
| **Claude Code** | `gsheets` 스킬이 시트 URL을 감지해 자동 호출 (`.claude/skills/gsheets/SKILL.md`) |
| **그 외 에이전트·에디터** | 통합 터미널에서 직접 실행. 에이전트에게는 이 문서 경로를 알려주면 됩니다 |
| **CI·컨테이너** | 브라우저가 없으므로 로컬에서 발급한 값을 환경변수로 주입 (아래) |

**CI·컨테이너 (브라우저 없는 환경)** — `auth.py`를 실행할 수 없으니 로컬에서 발급한 자격증명을 넘깁니다:

```bash
export GSHEETS_CLIENT_ID=...
export GSHEETS_CLIENT_SECRET=...
export GSHEETS_REFRESH_TOKEN=...     # macOS: security find-generic-password -s gsheets-oauth -a refresh_token -w
python3 gsheets.py tabs "<ID>"
```

환경변수가 키체인·설정 파일보다 우선합니다.

---

## 트러블슈팅

| 증상 | 원인 / 해결 |
|------|-------------|
| `자격증명이 없습니다(누락: ...)` | `auth.py` 미실행. 4단계 수행 |
| `The caller does not have permission` | 인증 계정에 시트가 공유되지 않음. **시트가 공유된 계정**으로 `auth.py` 재실행 |
| `API 실패 (HTTP 403)` + `has not been used in project` | 1단계 Sheets API 활성화 누락 (활성화 후 1~2분 전파 대기) |
| 쓰기 시 `HTTP 401/403` | 읽기 전용으로 인증됨. `python3 -u auth.py --write`로 재인증 |
| `토큰 갱신 실패` | refresh token 무효화. External+테스트는 **7일 만료** → `auth.py` 재실행, 또는 2단계를 Internal로 변경 |
| `refresh_token이 발급되지 않았습니다` | 이전 동의가 남아 있음. Google 계정 → 보안 → 서드파티 액세스에서 앱 권한 제거 후 재실행 |
| 인증 URL이 화면에 안 나옴 | `python3 -u`로 실행. 파이프(`| head`) 금지 |
| `포트 8080 바인딩 실패` | 다른 프로세스가 점유. `--port`로 변경 + 리디렉션 URI도 같은 포트로 등록 |
| `redirect_uri_mismatch` | 3단계 리디렉션 URI와 `--port`가 불일치. 정확히 `http://localhost:<포트>/callback` |
| 400 에러 + 탭 이름에 한글·`/` | A1 표기를 작은따옴표로 감싸지 않음 |

## 보안 노트

- 자격증명은 키체인 또는 `~/.config/gsheets/credentials.json`(600)에만 저장되며 **저장소에 커밋되지 않습니다**
- access token은 `~/.cache/gsheets/token.json`(600)에 캐시되고 만료 60초 전 자동 갱신됩니다
- **필요 없으면 읽기 전용으로 유지하세요.** refresh token은 장기 보관되므로 쓰기 권한까지 주면 사고 범위가 커집니다
- 공유 시트에 쓰는 작업은 되돌리기 어렵습니다. 에이전트에게 맡길 때는 **쓰기 전 대상 범위를 확인**하게 하세요 (`clear`는 `--yes` 없이는 거부됩니다)
