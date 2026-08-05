/**
 * 프로바이더(Anthropic / OpenAI / Azure)에 상관없이 동일하게 쓰는
 * 중립 메시지 · 툴 포맷. 각 어댑터가 이 포맷 ↔ 벤더 포맷을 변환한다.
 */

export type ProviderName = 'anthropic' | 'openai' | 'azure';

export interface ToolCall {
  id: string;
  /** `<서버이름>__<툴이름>` 형태 */
  name: string;
  input: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (object 타입) */
  inputSchema: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

/**
 * 모델 하나의 접속 정보. 모델마다 엔드포인트·키가 다를 수 있으므로
 * 프로바이더는 이 값으로 클라이언트를 만들고 캐시한다.
 */
export interface ModelConnection {
  provider: ProviderName;
  baseURL?: string;
  /** 키가 담긴 환경변수 이름. 클라이언트 캐시 키로도 쓰인다. */
  apiKeyEnv?: string;
}

export interface ChatRequest {
  connection: ModelConnection;
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  maxTokens: number;
  /** Anthropic 전용 — 다른 프로바이더는 무시 */
  thinking?: 'adaptive' | 'disabled';
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/** 어댑터가 한 턴 동안 흘려보내는 이벤트 */
export type ProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'turn_end'; assistant: { content: string; toolCalls: ToolCall[] } };

/** 클라이언트로 나가는 SSE 이벤트 */
export type StreamEvent =
  | { type: 'start'; appId: string }
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; preview: string; ms: number }
  | { type: 'done'; usage?: { iterations: number } }
  | { type: 'error'; message: string };
