---
name: gsheets
description: Use when a message, issue, or document contains a Google Sheets URL (docs.google.com/spreadsheets/... 테스트케이스·QA 시트·검증표·마스터 데이터) — lists tabs with their gid, reads a specific A1 range, and reads cell background colors when color carries meaning. 구글 시트/스프레드시트/테스트케이스 시트/QA 검증표 조회.
---

# Google Sheets 조회

## Overview

QA 테스트케이스·검증표·마스터 데이터는 Google Sheets 링크(`https://docs.google.com/spreadsheets/d/...`)로 전달되는 경우가 많다. 메시지·이슈 본문·문서 어디에 있든 링크만 있으면 이 스킬로 읽는다.

**핵심 원칙: 이런 시트는 셀 배경색에 의미를 싣는 경우가 많다.** `노란색 : 검증 필요`, `회색으로 칠한 영역은 검증 skip` 같은 범례를 헤더에 두고 상태를 **색으로만** 구분하는 시트가 흔하다. 텍스트만 읽으면 **어느 행이 대상인지 판별 불가**하다. 색이 의미를 갖는 정황이 보이면 반드시 경로 A의 `grid`로 읽는다.

## When to Use

- 메시지·이슈·문서 본문에 `https://docs.google.com/spreadsheets/` URL이 있을 때
- 테스트케이스 커버리지·검증 결과(pass/fail/미검증) 집계가 필요할 때
- 시트 내용이 구현·수정 판단의 근거일 때

## URL 파싱

```
https://docs.google.com/spreadsheets/d/{spreadsheetId}/edit?gid={gid}#gid={gid}
```

- `{spreadsheetId}` — `/spreadsheets/d/` 다음 세그먼트
- `{gid}` — 사용자가 **보고 있던 탭**. ⚠️ **gid는 탭 순서(index)가 아니다.** 임의의 정수이므로 `tabs`로 gid↔탭 이름을 먼저 매핑해야 어느 탭인지 알 수 있다.
- gid가 없으면 첫 번째 탭이다.

두 스크립트 모두 ID와 전체 URL을 모두 받는다 (URL을 주면 내부에서 파싱).

## 경로 A: `gsheets.py` (권장 — 탭·범위·색상 전부 가능)

표준 라이브러리만 쓰는 CLI라 터미널을 쓸 수 있는 에이전트·에디터 어디서든 같은 명령으로 동작한다.

```bash
cd .claude/skills/gsheets

# 읽기
python3 gsheets.py tabs   "<ID|URL>"                       # 탭 목록: gid·index·행x열·이름
python3 gsheets.py values "<ID|URL>" "'탭 이름'!A1:Z120"     # A1 범위의 값 (TSV)
python3 gsheets.py grid   "<ID|URL>" "'로그인/회원가입'!A1:P60"  # 값 + 배경색 hex
python3 gsheets.py dump   "<ID|URL>" --gid 745793729        # 탭 전체를 TSV로

# 쓰기 (--write 스코프로 인증된 경우에만)
printf 'a\tb\nc\td\n' | python3 gsheets.py set    "<ID|URL>" "'탭'!A1:B2"
printf 'x\ty\n'       | python3 gsheets.py append "<ID|URL>" "'탭'"
python3 gsheets.py clear "<ID|URL>" "'탭'!A1:B2" --yes
```

- 공통 옵션 `--json` — 집계·프로그램 처리용
- **탭 이름에 한글·공백·`/`가 있으면 A1 표기에서 작은따옴표로 감싼다**: `"'1차 / 2차 검증'!A1:Z50"`
- `grid` 출력은 `값[#rrggbb]` 형태이고, 기본 흰 배경은 노이즈라 생략된다
- `grid --json`은 **시트 실제 위치**를 준다 — `row`는 1-based 시트 행, `col`은 A1 열 문자(`c`는 0-based 열 인덱스). 범위가 `A1`이 아니어도(`'탭'!C5:E9`) 시트 화면의 행·열과 그대로 대응하므로 행 단위 집계에 쓸 수 있다
- access token은 만료 60초 전 자동 갱신된다 (`~/.cache/gsheets/token.json`, 0600)
- 쓰기 입력은 TSV(탭 구분). 파일은 `--tsv 경로`, 기본은 표준입력

### 쓰기는 확인 후에

공유 시트 수정은 **되돌리기 어렵고 다른 사람에게 즉시 보인다.** 쓰기 전에:

1. 대상 범위를 `values`/`grid`로 먼저 읽어 현재 값을 확인한다
2. 무엇을 어느 범위에 쓸지 사용자에게 알리고 승인을 받는다
3. `set`은 범위를 덮어쓴다 — 행 추가 의도면 `append`를 쓴다
4. `clear`는 `--yes` 없이는 거부된다

### 최초 1회 설정

**같은 디렉터리의 `SETUP.md`를 따른다.** GCP OAuth 클라이언트 발급 → `auth.py` 실행까지 5분이면 끝나고, 이후 재인증이 없다.

```bash
GSHEETS_CLIENT_ID=... GSHEETS_CLIENT_SECRET=... python3 -u auth.py            # 읽기 전용
GSHEETS_CLIENT_ID=... GSHEETS_CLIENT_SECRET=... python3 -u auth.py --write    # 읽기+쓰기
```

자격증명은 macOS 키체인(또는 그 외 OS는 `~/.config/gsheets/credentials.json`, 600)에만 저장되며 저장소에 남지 않는다. 설정이 안 된 사용자를 만나면 `SETUP.md`를 안내한다.

## 경로 B: claude.ai Google Drive 커넥터 (설정 없이 즉시, 단 손실 큼)

경로 A 설정이 안 된 환경에서 **일회성 조회**만 필요할 때 쓴다. Drive 커넥터가 인증돼 있으면 스프레드시트 본문을 자연어 표현으로 준다 (도구가 deferred면 ToolSearch로 스키마를 먼저 로드한다).

```
search_files       → 이름으로 시트 찾아 fileId 얻기
read_file_content  → fileId로 본문 읽기 (application/vnd.google-apps.spreadsheet 지원)
```

**한계 (검증됨)** — 이것 때문에 경로 A가 기본이다:

| 한계 | 영향 |
|------|------|
| 탭 이름이 안 나온다 | 표 경계만 추정 가능. `gid=...`가 어느 탭인지 특정 불가 |
| 셀 색상이 소실된다 | 색으로 표시한 "검증 필요/skip" 판별 불가 |
| A1 범위·탭 지정 불가 | 문서 전체가 한 번에 온다 (실측 113KB → 파일로 밀려 4회 분할 읽기) |

## 하지 말 것: 공식 Sheets MCP 등록

`https://sheetsmcp.googleapis.com/mcp/v1`이 존재하고 `get_values` 등을 노출하지만 **Claude Code에 붙지 않는다** — 시도해도 시간만 버린다:

- `.mcp.json`에 URL만 등록 → `Incompatible auth server: does not support dynamic client registration` (Google은 DCR 미지원)
- `--client-id`/`--client-secret`/`--callback-port`로 자체 클라이언트를 붙여도 **refresh token이 발급되지 않는다** (Claude Code의 범용 OAuth 플로우가 Google 전용 `access_type=offline`을 보내지 않음) → access token 1시간 만료 후 갱신 불가, 매시간 `/mcp` 재인증 필요
- 활성화할 API도 `sheets.googleapis.com`이 아니라 **`sheetsmcp.googleapis.com`**(Sheets MCP API)이라 헷갈린다

`auth.py`는 정확히 이 `access_type=offline` 문제를 해결한 것이다.

## 출력

- 문서 제목 + 탭 목록(gid·이름·크기), 사용자가 준 gid가 어느 탭인지 명시
- 요청 범위의 내용을 **표로 정리**. 색이 의미를 가지면 색별 의미를 함께 표기
- 테스트케이스 시트면 **검증 결과 분포**(pass/fail/미검증/N-A)와 **미착수 탭**을 집계해 밝힌다
- 본문에 있는 이슈 링크와 참조된 다른 시트 ID를 함께 추출
- 전체를 읽지 못했으면 **어느 범위를 못 읽었는지 명시**한다

## Common Mistakes

| 실수 | 결과 |
|------|------|
| gid를 탭 index로 착각 | 엉뚱한 탭을 읽음 — `tabs`로 매핑 먼저 |
| 색이 의미 있는 시트를 `values`로만 읽음 | "검증 필요/skip" 판별 누락 — `grid`로 읽어야 함 |
| 한글·`/` 포함 탭 이름을 따옴표 없이 A1 표기 | 400 에러 — `"'탭 이름'!A1:Z50"`으로 감싼다 |
| 범위 없이 `dump`로 대형 시트를 통째로 | 출력이 파일로 밀려 분할 읽기 — 필요한 탭·범위만 지정 |
| 일부만 읽고 전체 집계를 단정 | 커버리지·pass율을 틀리게 보고. 읽은 범위를 밝히거나 `--json`으로 집계 |
| 경로 A 미설정 상태에서 Drive 결과를 완전하다고 보고 | 탭 이름·색상이 빠진 걸 모른 채 결론 |
| 공식 Sheets MCP 등록 재시도 | refresh token 미발급으로 실패 — 위 "하지 말 것" 참조 |
