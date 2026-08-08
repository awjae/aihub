# AI Hub — 사내 AI 게이트웨이

사내에서 만든 fine-tuned 모델과 MCP 도구를, 비개발직군이 **간단한 폼**으로 써볼 수 있게 열어주는 내부 서비스.

```
[사용자] 폼 제출
   ↓
NestJS 게이트웨이
   ├─ apps.json 에서 모델·앱 정의 로드 → 프롬프트 렌더링
   ├─ MCP 서버들에서 tool 목록 수집
   ├─ 모델 호출 (OpenAI 및 OpenAI 호환 엔드포인트)
   ├─ tool_use → MCP 실행 → 결과 반환 → 모델 재호출  (반복)
   ↓
[화면] 응답 영역에 실시간 출력 + 도구 실행 로그(접기)
```

- **서버**: NestJS 11 (TypeScript)
- **프론트**: React 19 + Vite
- **출력**: SSE 스트리밍
- **인증**: 없음 — **사내망/VPN 뒤에서만 노출한다는 전제**입니다 ([아래 참고](#보안-전제))

---

## 빠른 시작

```bash
cp .env.example .env      # API 키 채우기
docker compose up --build # → http://localhost:3000
```

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
| **`apps`** | `name`, `icon`, `fields`, `requireOneOf`, `mcpServers` + 모델 참조 | 사용자에게 어떻게 보이는가 |

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
      ],

      "mcpServers": []                      // mcp.json 의 서버 이름. 비우면 툴 없이 프롬프트만.
    }
  ]
}
```

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

## MCP 도구 연결하기

`config/mcp.json` 에 서버를 정의하고, 앱의 `mcpServers` 에 이름을 적으면 그 앱에서만 해당 툴이 노출됩니다.

```json
{
  "mcpServers": {
    "internal-docs": {
      "type": "http",
      "url": "https://mcp.internal.example.com/mcp",
      "headers": { "Authorization": "Bearer ${INTERNAL_MCP_TOKEN}" }
    },
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
    }
  }
}
```

- 값 안의 `${VAR}` 는 환경변수로 치환됩니다 → **토큰을 파일에 하드코딩하지 마세요.**
- `disabled: true` 로 임시 비활성화할 수 있습니다.
- 툴 이름은 `<서버이름>__<툴이름>` 으로 네임스페이싱되어 서버 간 충돌이 없습니다.
- 서버당 커넥션 1개를 재사용하고, 끊기면 다음 요청에서 자동 재연결합니다.
- **툴 하나가 실패해도 요청 전체가 죽지 않습니다** — 에러 문자열이 툴 결과로 모델에 전달되어 모델이 대안을 찾습니다.

---

## API

| 메서드 | 경로                | 설명                                      |
| ------ | ------------------- | ----------------------------------------- |
| `GET`  | `/api/health`       | 헬스체크 (로드된 앱 개수 포함)            |
| `GET`  | `/api/apps`         | 앱 목록 (프롬프트·모델명은 미노출)        |
| `GET`  | `/api/apps/:id`     | 앱 하나                                   |
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

`reasoning` 이벤트는 모델이 추론 요약을 흘려줄 때만 옵니다. POST 로 SSE 를 내려주므로 프론트는 `EventSource` 대신 `fetch` + `ReadableStream` 으로 읽습니다.

---

## 환경변수

`.env.example` 참고. 주요 항목:

| 변수                                                              | 설명                                             |
| ----------------------------------------------------------------- | ------------------------------------------------ |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL`                              | OpenAI, 또는 사내 vLLM·LiteLLM 등 호환 엔드포인트 |
| `MAX_TOOL_ITERATIONS`                                             | 툴 루프 상한 (기본 8) — 무한 루프 방지           |
| `MCP_TOOL_TIMEOUT_MS`                                             | 툴 1회 타임아웃 (기본 60s)                       |
| `MAX_TOOL_RESULT_CHARS`                                           | 툴 결과 절삭 길이 (기본 20,000자)                |
| `CORS_ORIGIN`                                                     | 프론트가 다른 오리진일 때 (쉼표 구분)            |
| `VPN_OVPN_CONFIG`                                                 | Client VPN `.ovpn` 경로. 비우면 VPN 기능 전체가 꺼짐 |
| `VPN_PROBE_TARGET`                                                | 도달 확인 대상 `host:port` (비우면 `DATABASE_URL`)   |

---

## Client VPN (VPC 밖에 띄울 때만)

VPC 내부 자원을 읽는 앱은 정의에 `"requiresVpn": true` 를 적습니다. 그러면 화면에 연결 상태가 뜨고, **실제로 닿기 전에는 실행 버튼이 잠깁니다** — 제출하고 수십 초 기다린 끝에 커넥션 실패만 보는 상황을 막기 위해서입니다.

`VPN_OVPN_CONFIG` 가 비어 있거나 파일이 없으면 **기능 전체가 꺼지고 화면에도 아무것도 뜨지 않습니다.** VPC 안에 배포했다면 그대로 두세요.

| 엔드포인트             | 하는 일                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `GET /api/vpn/status`  | 상태 조회. 폴링용이라 **아무것도 바꾸지 않습니다**               |
| `POST /api/vpn/recheck`| 상태를 다시 재고, VPN 이 켜져 있으면 터널 재접속을 앞당깁니다     |

> **서브넷 연결은 여기서 켜고 끄지 않습니다.** 접속이 없어도 연결 시간만큼 과금되므로 개발자가 akita 저장소의 `client-vpn.sh production on/off` 로 직접 제어하고, 게이트웨이는 그 상태를 따라가기만 합니다. 그래서 AWS 자격증명도 필요 없습니다.

컨테이너 안에서 터널을 세우려면 `docker-compose.yml` 의 `cap_add: NET_ADMIN` · `devices: /dev/net/tun` · `user: root` 주석을 풀어야 합니다. 기본 권한을 올리지 않으려고 옵트인으로 두었습니다.

---

## 보안 전제

인증이 없습니다. **반드시 사내망 / VPN / 리버스 프록시 뒤에만 노출하세요.** 공개 인터넷에 올리면 누구나 사내 모델과 MCP 도구를 호출할 수 있습니다.

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
  mcp.json            MCP 서버 정의
server/src/
  apps/               schema.ts(zod, 단일 출처) · 로드/검증 · 프롬프트 렌더링
  providers/          OpenAI 호환 어댑터 (벤더별 히스토리 보존)
  mcp/                MCP 커넥션 풀, 툴 목록 수집, 툴 실행
  chat/               툴 루프 오케스트레이션 + SSE 컨트롤러
  common/             중립 메시지·이벤트 타입, 헬스체크
web/src/
  components/         AppRunner, DynamicForm, ResponsePanel, ToolLog
  lib/                API 클라이언트(SSE 파서), 타입
```

프로바이더 어댑터는 **각자 벤더 네이티브 포맷으로 히스토리를 보관**합니다. 중립 포맷으로 매 턴 왕복시키면 벤더 고유 블록(추론·서명 등)처럼 다음 턴에 그대로 돌려줘야 하는 정보가 유실되기 때문입니다. 지금은 어댑터가 하나뿐이지만, 벤더를 추가할 때는 이 규칙대로 새 어댑터를 만드세요.
