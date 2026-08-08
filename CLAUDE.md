# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An internal AI gateway. Non-developers pick a form, submit it, and get a streamed model response. Developers add models and forms by editing one config file. NestJS backend + React/Vite frontend, packaged as a single Docker image (the server serves the built frontend from `/app/public`).

**There is no authentication by design** — this is meant to run behind a VPN / internal network only. Don't add auth-adjacent features assuming one exists.

`VpnModule` is the one part that touches the network rather than models: an app marked `requiresVpn` reads something inside a VPC, so a Client VPN tunnel has to be up before it can. It stays **off unless `VPN_OVPN_CONFIG` points at a real file**, and the frontend renders nothing when the server reports `configured: false` — deployed inside the VPC, none of it applies.

Two boundaries are deliberate and easy to erode:

- **It never turns the VPN on or off.** The subnet association is billed by connection-time, so a developer controls it from the akita repo (`client-vpn.sh production on/off`, EMR-56246). Putting a button here would move a billed, shared switch behind an unauthenticated page. The gateway only *follows*.
- **It knows the state without AWS credentials.** Client VPN publishes the endpoint's DNS name only while a subnet is associated, so resolving the host taken from the `.ovpn` answers "can we connect right now?". Don't reintroduce the AWS SDK for this — it was tried and removed.

The tunnel is raised on demand, not at boot: opening a `requiresVpn` app and pressing 다시 확인 both call `POST /api/vpn/recheck`. `GET /api/vpn/status` is for polling and must stay side-effect free.

## Commands

```bash
# Server (from server/)
npm run start:dev     # watch mode, :3000
npm run build         # nest build → dist/
npm run typecheck     # tsc --noEmit
npm run schema        # REGENERATE config/apps.schema.json from zod (see below)

# Frontend (from web/)
npm run dev           # vite :5173, proxies /api → :3000
npm run build         # tsc -b && vite build
npm run typecheck

# Whole thing
docker compose up -d --build     # → :3000
docker compose logs -f
curl -X POST localhost:3000/api/apps/reload   # re-read config without restart
```

**There is no test framework.** Verification is done by running the container and driving the API with `curl` / small `tsx` scripts. When changing parsing or validation, exercise the real endpoints — several bugs here were only visible end-to-end (see "Landmines").

## Architecture

### The models/apps split is the central design decision

`config/apps.json` has two top-level sections, and which section a setting belongs in is not arbitrary:

- **`models`** own the *contract*: `provider`, `model`, `baseURL`, `apiKeyEnv`, `systemPrompt`, `userTemplate`, `responseFormat`. For a fine-tuned model these are fixed by its **training data** — the prompt shape it was trained on and the output shape it emits.
- **`apps`** own the *UI*: `name`, `icon`, `fields`, `requireOneOf`, `mcpServers`, plus a `model` name reference.

Multiple apps can share one model without duplicating the prompt contract. If someone wants "same model, different prompt", the answer is a second `models` entry — not an app-level override. There is deliberately no override mechanism.

`AppsService.load()` resolves each app against its model into a `ResolvedApp { app, model }`; everything downstream takes that pair.

### Request flow

`ChatController` (SSE) → `ChatService.run()` → provider session ↔ `McpService`.

`ChatService` owns the tool loop: run a turn, collect `tool_use`, execute via MCP in parallel, feed results back, repeat until no tool calls or `MAX_TOOL_ITERATIONS`. Providers only know how to run **one turn**.

### Provider sessions keep vendor-native history — do not "simplify" this

`ProviderSession` (`providers/provider.interface.ts`) holds the conversation in each vendor's own format. There is only one provider today (OpenAI), so the seam looks redundant — it is not. Vendors require their own opaque blocks (reasoning, signatures) to be echoed back **unmodified** across tool-loop turns, and round-tripping through a neutral message type silently drops them. Adding a provider means implementing `runTurn()` + `addToolResults()` against that vendor's SDK, not extending a shared message mapper.

An Anthropic adapter and an Azure variant existed and were removed once nothing used them; re-add by the same rule rather than by generalizing the OpenAI one.

Clients are cached per `(baseURL, apiKeyEnv)` so different models can use different endpoints and credentials. `apiKeyEnv` is the **name** of an env var, resolved in `providers/credentials.ts` — config files never contain secrets.

### Validation has one source of truth

`server/src/apps/schema.ts` (zod) is authoritative. `config/apps.schema.json` is a **generated artifact** for editor autocomplete — regenerate with `npm run schema` after touching schema rules; never hand-edit it.

**Pre-commit obligation.** If a change touches `server/src/apps/schema.ts`, the regenerated `config/apps.schema.json` must be staged in the same commit — otherwise editor autocomplete silently diverges from what the server actually accepts.

```bash
npm --prefix server run schema
git add config/apps.schema.json
```

Objects use `z.strictObject`, so unknown keys are rejected rather than ignored (a `defaultValue` typo previously failed silently). Cross-checks zod can't express — model reference exists, every `{{key}}` in `userTemplate` has a matching field, `requireOneOf` keys exist — live in `AppsService.load()`.

Config is **JSONC**: comments and trailing commas allowed, parsed by `apps/jsonc.ts` (string-aware, so `https://` isn't treated as a comment). YAML support existed and was removed once nothing used it.

### Response rendering is config-driven

Output format varies per model, so parsing rules live in `responseFormat` rather than in code. `type: "records"` + a `marker` template (`[{key}]:`) is parsed **client-side** by `web/src/lib/parseRecords.ts`; a repeated key starts a new record, so N diagnoses become N cards automatically. **Parsing always falls back to raw text on failure** — a model changing its output must never break the screen.

### Error surfacing

- **Boot**: invalid config crashes the process (fail fast; Docker restart-loops).
- **Reload**: returns 400 with the zod path/message and **keeps the previously loaded definitions**, so a bad edit can't take down a running service.
- **Mid-request**: SSE headers are already sent, so failures arrive as `{"type":"error"}` stream events, not HTTP status codes. The frontend must read them from the stream.
- **MCP tool failure**: returned to the model as an error-flagged tool result, never thrown — the model gets to recover.

## Landmines

These were real bugs; the fix is easy to undo by accident.

- **`default` applies only when a key is absent**, not when it's `""`. An empty string means the user cleared the field; substituting the default back resurrects deleted input and defeats `requireOneOf`.
- **Template lines whose placeholders are all empty are dropped entirely** (`AppsService.renderTemplate`). Otherwise an unfilled optional field leaves a bare `Subjective)` label in the prompt, diverging from the fine-tune's training format. Consequence: optional fields must each be on their own line in `userTemplate`.
- **`parseRecords` partial-marker stripping applies only to the last value, and only when the marker has a non-empty literal prefix.** Without both guards it eats real content (a `{key} =` marker truncated `mg/kg` → `mg/`).
- **Length checks use the trimmed string**, so whitespace-only input can't bypass `minLength`.
- Frontend validation (`web/src/lib/validate.ts`) mirrors the server's rules to save a round trip. **The server is still the judge** — keep the two in sync, don't move the check.

## Conventions

- Code comments and all user-facing strings (errors, UI, config comments) are in **Korean**.
- Server tsconfig uses `module: node16` — required for the MCP SDK's `exports`-only subpaths.
- MCP tools are namespaced `<server>__<tool>` to avoid collisions across servers.
- `config/` is bind-mounted read-only in `docker-compose.yml`, so config edits + `/api/apps/reload` need no rebuild.
