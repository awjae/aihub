# AI Hub — 사내 AI 게이트웨이

사내에서 만든 fine-tuned 모델과 원내 데이터 질의를, 비개발직군이 **간단한 폼**으로 써볼 수 있게 열어주는 내부 서비스.

```
[사용자] 폼 제출
   ↓
NestJS 게이트웨이 — 앱의 mode 로 갈림
   │
   ├─ model : 프롬프트 렌더링 → 모델 호출 → 응답 스트리밍
   └─ query : 질문 → SQL(자식 프로세스) → 조회(게이트웨이 풀) → 표
   ↓
[화면] 실시간 출력 / 결과 표 + 근거 SQL
```

- **서버**: NestJS 11 (TypeScript)
- **프론트**: React 19 + Vite
- **출력**: SSE 스트리밍
- **인증**: 없음 — **사내망/VPN 뒤에서만 노출한다는 전제**입니다 ([아래 참고](#보안-전제))

---

## 빠른 시작

```bash
cp .env.example .env       # API 키 채우기
npm run env:deploy         # .env → .env.deploy (도커용 경로로 변환)
docker compose up --build  # → http://localhost:3000
```

`.env` 는 로컬 실행(cwd 가 `server/`) 기준이고, 컨테이너는 `/app` 에서 돌아 경로가 어긋납니다. `.env.deploy` 는 `.env` 에서 파생된 도커용 파일이라 **시크릿의 원본은 `.env` 하나뿐**입니다 — 값을 바꾸면 `npm run env:deploy` 를 다시 돌리세요 (`npm run env:check` 로 어긋남 확인).

배포용 이미지 말기 (로컬에서 빌드 → ECR):

```bash
npm run image:build      # PLATFORM=linux/amd64 기본 — AWS 가 x86_64 라서
npm run image:verify     # 볼륨 없이 띄워 health + 질의 생성기까지 확인
REGISTRY=<계정>.dkr.ecr.ap-northeast-2.amazonaws.com npm run image:release
```

- `akita_schema` 가 형제 디렉터리에 있어야 합니다 (`AKITA_CONTEXT` 로 변경 가능). 없으면 도커의 모호한 메시지 대신 그 사실을 먼저 알려줍니다.
- Graviton 인스턴스면 `PLATFORM=linux/arm64`.
- 태그는 기본이 `YYYYMMDD-HHMM` 이며 `TAG` 로 지정할 수 있습니다.

로컬 개발(핫 리로드):

```bash
# 터미널 1 — 서버
cd server && npm install && npm run start:dev      # :3000

# 터미널 2 — 프론트 (/api 는 :3000 으로 프록시)
cd web && npm install && npm run dev               # :5173
```

---

## 모델과 앱(폼) 추가하기

`config/apps.json` 은 두 부분으로 나뉩니다.

| | 소유하는 것 | 왜 |
|---|---|---|
| **`models`** | `provider`, `model`, `baseURL`, `apiKeyEnv`, `systemPrompt`, `userTemplate`, `responseFormat` | fine-tuned 모델은 **입력·출력 규약이 학습 데이터로 정해져** 있습니다. 앱이 아니라 모델의 속성입니다. |
| **`apps`** | `mode`, `name`, `icon`, `fields`, `requireOneOf` + 모델 참조 | 사용자에게 어떻게 보이는가 |

- **모델 추가** = `models` 에 항목 하나
- **폼 추가** = `apps` 에 항목 하나 (같은 모델을 여러 앱이 공유 가능 — 프롬프트 규약이 복사되지 않음)

```jsonc
{
  "models": {
    "vet-diagnosis": {
      "provider": "openai",                 // OpenAI 호환 엔드포인트 포함
      "model": "ft:gpt-4o-mini:acme::abc",
      "maxTokens": 2000,
      "systemPrompt": "너는 ... 이다.",
      "userTemplate": ["Subjective) {{subjective}}", "Objective) {{objective}}"],
      "responseFormat": { /* 아래 참고 */ }
    },

    "internal-llama": {                      // 모델마다 엔드포인트·키가 달라도 됨
      "provider": "openai",                  // OpenAI 호환이면 openai
      "baseURL": "http://vllm.internal:8000/v1",
      "apiKeyEnv": "VLLM_TOKEN",             // 키 "값"이 아니라 환경변수 "이름"
      "model": "llama-3-70b-vet",
      "userTemplate": ["{{question}}"]
    }
  },

  "apps": [
    {
      "id": "diagnosis-predictor",          // URL 해시(#diagnosis-predictor)로 진입 가능
      "name": "진단 예측 AI",
      "description": "사이드바에 표시될 한 줄 설명",
      "icon": "🩺",
      "group": "진료 지원",                  // 사이드바 그룹핑

      "model": "vet-diagnosis",             // models 의 이름을 참조

      "requireOneOf": ["subjective", "objective"],  // 최소 하나는 입력 (생략 가능)

      "fields": [
        {
          "key": "subjective",              // 모델 userTemplate 의 {{subjective}} 와 대응
          "label": "Subjective",
          "type": "textarea",               // text | textarea | select | number | checkbox
          "rows": 8,
          "minLength": 10,
          "placeholder": "안내 문구",
          "default": "폼 초기값"
        }
      ]
    }
  ]
}
```

모델 없이 조회만 하는 앱은 `mode: "query"` 입니다 — [아래 절](#원내-데이터-질의-mode-query) 참고.

> **모델은 같은데 프롬프트만 다르게 쓰고 싶다면** 앱에서 덮어쓰는 대신 `models` 에 항목을 하나 더 만드세요. "이 규약으로 말을 건다"가 모델 단위로 유지되는 편이 추적하기 쉽습니다.

> **설정 파일은 JSONC 입니다** — 순수 JSON 이지만 주석(`//`, `/* */`)과 후행 쉼표를 쓸 수 있습니다. 문자열 안의 `//`(URL 등)는 주석으로 오인하지 않습니다.
>
> **에디터에 빨간 줄이 뜬다면** — 에디터가 `.json` 을 순수 JSON 으로 검사해서입니다. `.vscode/settings.json` 이 `config/*.json` 을 `jsonc` 로 매핑해두었으니 VS Code 는 그대로 열면 됩니다.
>
> **여러 줄 문자열은 배열로.** `systemPrompt`, `userTemplate`, 필드의 `default` 는 문자열 배열을 주면 줄바꿈으로 이어집니다.


### 응답 표시 (`responseFormat`) — 모델 소유

모델마다 출력 포맷이 다르므로 **파싱 규칙을 모델에 선언**합니다. 기본값은 `text` (모델 출력을 그대로 표시).

모델이 `[code]: MASS-01159 [name]: Otitis Externa [name_ko]: 외이염` 처럼 답한다면:

```jsonc
"responseFormat": {
  "type": "records",
  "itemLabel": "추천 진단",   // 카드 제목 → "추천 진단 1", "추천 진단 2"
  "marker": "[{key}]:",      // 값 앞에 오는 마커. {key} 자리에 키 이름이 들어감
  "rows": [
    { "label": "진단명",     "value": "{name_ko} ({name})" },
    { "label": "마스터 코드", "value": "{code}", "style": "code" }  // 등폭 폰트
  ]
}
```

→ 화면에 이렇게 표시됩니다:

```
추천 진단 1
  진단명     외이염 (Otitis Externa)
  마스터 코드  MASS-01159
```

동작 규칙:

- **이미 나온 키가 다시 나오면 새 레코드**로 봅니다 → 모델이 여러 개를 내면 카드가 자동으로 늘어납니다 (줄바꿈으로 나뉘든 한 줄에 이어 붙든 동일).
- `value` 가 참조한 키가 **전부 비면 그 행을 숨기고**, 일부만 비면 남는 빈 괄호를 정리합니다 (`{name_ko} ({name})` 에서 영문명이 없으면 → `외이염`).
- **파싱에 실패하면 모델 원문을 그대로** 보여줍니다. 포맷이 바뀌어도 화면이 깨지지 않습니다.
- 복사 버튼은 화면에 보이는 형태 그대로 복사합니다.

`marker` 는 어떤 형식이든 됩니다 (`{key} =`, `<{key}>` …). 다만 `[{key}]:` 처럼 **구분이 뚜렷한 마커**를 쓰세요 — `{key}:` 같이 느슨하면 값 안의 문자열을 마커로 오인할 수 있습니다.

### 입력 검증

| 키               | 위치  | 동작                                                              |
| ---------------- | ----- | ----------------------------------------------------------------- |
| `required`       | field | 비어 있으면 거부                                                  |
| `minLength` / `maxLength` | field | `text`·`textarea` 전용. **앞뒤 공백을 제외한** 길이 기준 |
| `min` / `max`    | field | `number` 전용                                                     |
| `requireOneOf`   | app   | 나열한 키 중 최소 하나가 채워져야 실행 가능                       |

`text`/`textarea` 값은 앞뒤 공백이 제거된 뒤 프롬프트에 들어갑니다 — 공백만 입력해 길이 제한을 우회할 수 없습니다.

검증은 **서버가 최종 판정**하되, 프론트에서도 같은 규칙으로 미리 걸러 실행 버튼을 잠그고 부족한 글자 수를 실시간으로 보여줍니다.

### 빈 항목이 있는 줄은 자동으로 빠집니다

`userTemplate`에서 **플레이스홀더가 전부 비어 있는 줄은 통째로 제거**됩니다. 선택 입력의 라벨이 빈 채로 프롬프트에 남아 fine-tuning 학습 데이터와 형식이 어긋나는 것을 막기 위해서입니다.

```jsonc
"userTemplate": ["Subjective) {{subjective}}", "Objective) {{objective}}"]
```

| 입력                | 모델에 전송되는 user 메시지                        |
| ------------------- | -------------------------------------------------- |
| 둘 다 입력          | `Subjective) …\nObjective) …`                      |
| Objective 만 입력   | `Objective) …` ← 빈 `Subjective)` 줄 없음          |
| Subjective 만 입력  | `Subjective) …`                                    |

여러 항목을 **한 줄에** 배치하면(`{{a}} / {{b}}`) 줄 단위 생략이 동작하지 않으니, 선택 입력은 각자 다른 줄에 두세요.

### 반영

```bash
curl -X POST http://localhost:3000/api/apps/reload
```

`docker-compose.yml` 이 `./config` 를 컨테이너에 마운트하므로, **이미지 재빌드 없이** 파일 수정 → reload 로 반영됩니다.

정의에 오류가 있으면 reload 가 400 과 함께 **어디가 잘못됐는지** 알려주고, **기존 정의는 그대로 유지**됩니다 (잘못된 설정으로 돌던 서비스가 죽지 않음).

```
apps[0].fields[0]: 알 수 없는 항목 'defaultValue'. 사용 가능: key, label, type, …
```

정의되지 않은 키는 무시하지 않고 거부합니다 — 오타가 조용히 먹히지 않도록.

**검증 규칙의 출처는 `server/src/apps/schema.ts` (zod) 한 곳입니다.** 에디터가 읽는 `config/apps.schema.json` 은 거기서 생성된 산출물이라 둘이 어긋날 수 없습니다.

```bash
cd server && npm run schema   # 스키마 규칙을 바꿨다면 재생성
```

문법이 깨진 경우엔 줄·칸 위치까지 짚어줍니다:

```
/app/config/apps.json: JSON 형식이 올바르지 않습니다 (5번째 줄, 3번째 칸) — Expected ',' or '}' …
```

---

## 원내 데이터 질의 (`mode: "query"`)

질문을 SQL 로 바꿔 조회하고 **표를 그대로** 보여줍니다. 답변 문장이 없습니다.

```
질문 ──► 자식 프로세스 (akita_schema CLI)
           질문 + 스키마 → LLM → QueryPlan → SQL      ← LLM 은 여기까지만
   ◄── {sql, parameters}
게이트웨이 ──► pg 풀로 실행 ──► 표
```

**조회 결과는 어떤 프롬프트에도 들어가지 않습니다.** 밖으로 나가는 것은 질문과 스키마뿐입니다.

```jsonc
{
  "id": "clinic-data-qa",
  "mode": "query",
  "requiresVpn": true,                      // 연결 전에는 실행 버튼이 잠김
  "questionTemplate": "{{question}}",       // 폼 입력 → 질의 생성기에 넘길 질문
  "fields": [{ "key": "question", "label": "질문", "type": "textarea", "required": true }]
}
```

- **질의마다 새 자식 프로세스**입니다. 카탈로그 로드 14ms, 기동까지 90~100ms — LLM 왕복 수 초에 묻히고, 자식이 죽어도 게이트웨이는 멀쩡합니다.
- **자식은 DB 를 안 건드립니다.** 커넥션 풀은 게이트웨이가 들고 재사용합니다. 거기서 실행하면 VPN 너머 TLS 핸드셰이크를 매번 치릅니다.
- **읽기 전용 2겹** — 풀이 `default_transaction_read_only=on` 이고, 단일 `SELECT` 렉시컬 가드가 실행 전에 한 번 더 막습니다.
- 생성 SQL 은 `repository.node_*` 로 스키마가 한정돼, 화면에 보이는 SQL 을 psql 에 그대로 붙여도 돕니다.

| 환경변수 | |
| --- | --- |
| `AKITA_QUERY_CLI` | 질의 생성기 진입 파일 (컨테이너는 Dockerfile 이 잡음) |
| `WORKSPACE_ID` | 조회할 병원의 node id |
| `DATABASE_URL` | 읽기 전용 계정 권장 |
| `LLM_MODEL` | 질문→SQL 변환 모델. `OPENAI_API_KEY` 를 같이 씀 |
| `MAX_ROWS` | 한 번에 보여줄 최대 행 수 (기본 50) |

---

---

## Client VPN — 상태만 보여줍니다

VPC 밖에서 띄우면 "원내 데이터 질의" 화면 위에 연결 상태가 뜹니다. **켜고 끄는 버튼은 없습니다.**

Client VPN 은 접속이 없어도 서브넷 연결 시간만큼 과금되므로(EMR-56246), 켜고 끄는 것은 **개발자가 akita 저장소에서 직접** 합니다.

```bash
cd ../akita
./scripts/client-vpn.sh production on     # 5~6분. 다 쓰면 off — 안 끄면 계속 과금
```

게이트웨이는 그 상태를 따라가기만 합니다. **AWS 자격증명이 필요 없습니다.**

```bash
# .ovpn 만 넣으면 끝 (akita 저장소에서 make prod-ovpn)
cp ../akita/.ovpn/production.ovpn config/production.ovpn

# .env
VPN_OVPN_CONFIG=/app/config/production.ovpn

# 터널용 권한(cap_add / devices / user: root)은 docker-compose.yml 에 이미 켜져 있습니다.
# VPC 안에 띄워 VPN 이 필요 없으면 거기서 주석 처리하세요.
docker compose up -d --build
```

| | |
| --- | --- |
| `GET /api/vpn/status` | 엔드포인트 DNS 해석 여부·터널·**DB 도달 여부** |
| `POST /api/vpn/recheck` | 상태를 다시 재고, VPN 이 켜졌으면 터널 접속을 시도 |

**터널은 필요할 때만 세웁니다.** 접속을 시도하는 계기는 둘뿐입니다 — 사용자가 그 앱을 열었을 때, 그리고 "다시 확인" 을 눌렀을 때. `status` 는 폴링용이라 아무 것도 바꾸지 않습니다.

> **어떻게 자격증명 없이 아나** — Client VPN 은 서브넷이 연결돼 있을 때만 엔드포인트 이름을 DNS 에 게시합니다. `.ovpn` 에서 호스트를 뽑아 해석해 보는 것으로 "지금 붙을 수 있는가" 를 알 수 있습니다.
>
> **"다시 확인" 이 재시도를 앞당깁니다** — openvpn 은 실패할수록 재시도 간격을 2배로 늘려 최대 5분까지 벌립니다(실측 2→4→8→16→32초…). 방금 켠 VPN 에 그만큼 기다리지 않도록 프로세스를 새로 띄워 간격을 되돌립니다.
>
> **`.ovpn` 은 받은 그대로 두세요.** AWS 가 내려주는 파일에는 `remote *.cvpn-endpoint-…` 처럼 와일드카드가 들어 있어 `remote-random-hostname` 과 겹치면 DNS 가 실패합니다. 서버가 시작할 때 사본을 만들어 정규화하므로 손댈 필요가 없습니다.
>
> **ECS Fargate 에서는 동작하지 않습니다.** Fargate 는 `devices`(`/dev/net/tun`) 를 지원하지 않고 `capabilities.add` 도 `SYS_PTRACE` 만 허용합니다. **EC2 시작 유형**을 쓰고 태스크 정의에 `NET_ADMIN`·`/dev/net/tun`·`user: root` 를 넣으세요.

---

## API

| 메서드 | 경로                | 설명                                      |
| ------ | ------------------- | ----------------------------------------- |
| `GET`  | `/api/health`       | 헬스체크 (로드된 앱 개수 포함)            |
| `GET`  | `/api/apps`         | 앱 목록 (프롬프트·모델명은 미노출)        |
| `POST` | `/api/apps/reload`  | 설정 다시 읽기 → `{models, apps}` 개수 반환 |
| `POST` | `/api/run/:appId`   | 앱 실행 → **SSE 스트림**                  |

`POST /api/run/:appId` 요청/응답:

```jsonc
// 요청
{ "input": { "first": "...", "second": "..." } }

// 응답 (text/event-stream)
data: {"type":"start","appId":"my-app"}
data: {"type":"tool_call","id":"call_1","name":"docs__search","input":{...}}
data: {"type":"tool_result","id":"call_1","name":"docs__search","ok":true,"preview":"...","ms":312}
data: {"type":"text","text":"안녕"}
data: {"type":"done","usage":{"iterations":2}}
// 실패 시
data: {"type":"error","message":"..."}
```

`data` 이벤트는 `direct` 모드 결과입니다 — 모델을 거치지 않은 구조체가 그대로 옵니다. POST 로 SSE 를 내려주므로 프론트는 `EventSource` 대신 `fetch` + `ReadableStream` 으로 읽습니다.

---

## 환경변수

`.env.example` 참고. 주요 항목:

| 변수                                                              | 설명                                             |
| ----------------------------------------------------------------- | ------------------------------------------------ |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL`                              | OpenAI, 또는 사내 vLLM·LiteLLM 등 호환 엔드포인트 |
| `MAX_ROWS`                                                        | 한 번에 보여줄 최대 행 수 (기본 50)              |
| `CORS_ORIGIN`                                                     | 프론트가 다른 오리진일 때 (쉼표 구분)            |

---

## 보안 전제

인증이 없습니다. **반드시 사내망 / VPN / 리버스 프록시 뒤에만 노출하세요.** 공개 인터넷에 올리면 누구나 사내 모델과 원내 데이터를 조회할 수 있습니다.

나중에 붙일 때 손댈 곳:

- **SSO(OIDC)** — `server/src/main.ts` 에 가드를 전역 등록하고, `AppDefinition` 에 `allowedGroups` 를 추가해 앱별 권한 분리
- **사용량 추적** — `ChatService.run()` 이 이미 `iterations` 를 집계하므로 여기에 사용자 ID·토큰 수를 붙여 로깅
- **레이트 리밋** — `@nestjs/throttler` 를 `/api/run` 에 적용

리버스 프록시(nginx 등)를 쓴다면 SSE 버퍼링을 꺼야 합니다. 서버가 `X-Accel-Buffering: no` 를 내려주지만, `proxy_buffering off;` 와 넉넉한 `proxy_read_timeout` 도 함께 설정하세요.

---

## 구조

```
config/
  apps.json           모델 + 앱(폼) 정의 — 여기만 고치면 됨
  apps.schema.json    에디터용 (zod 에서 자동 생성)
server/src/
  apps/               schema.ts(zod, 단일 출처) · 로드/검증 · 프롬프트 렌더링
  providers/          OpenAI 어댑터 (벤더 네이티브 히스토리 보존)
  query/              질문 → SQL(자식 프로세스) + 실행(pg 풀, 읽기 전용 가드)
  run/                SSE 컨트롤러 + 실행기 둘 (model / query)
  vpn/                Client VPN 연결·해제 (VPC 밖에 띄울 때만)
  common/             중립 메시지·이벤트 타입, 헬스체크
web/src/
  components/         AppRunner, DynamicForm, ResponsePanel, DataResult, VpnPanel
  lib/                API 클라이언트(SSE 파서), 타입
scripts/              이미지 빌드·검증·push
```

프로바이더 어댑터는 **각자 벤더 네이티브 포맷으로 히스토리를 보관**합니다. 중립 포맷으로 매 턴 왕복시키면 벤더 고유 블록(reasoning·서명 등)처럼 다음 턴에 그대로 돌려줘야 하는 정보가 유실되기 때문입니다. 지금은 어댑터가 하나뿐이지만, 벤더를 추가할 때는 이 규칙대로 새 어댑터를 만드세요.
