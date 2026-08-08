export type FieldType = 'text' | 'textarea' | 'select' | 'number' | 'checkbox';

export interface FieldDefinition {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
  help?: string;
  rows?: number;
  options?: string[];
  default?: string | number | boolean | string[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
}

export interface ResponseRow {
  label: string;
  /** `{key}` 에 파싱된 값이 치환된다. 예: `{name_ko} ({name})` */
  value: string;
  style?: 'text' | 'code';
}

export interface RecordsFormat {
  type: 'records';
  itemLabel: string;
  /** 값 앞에 오는 마커. `{key}` 자리에 키 이름이 들어간다. 예: `[{key}]:` */
  marker: string;
  rows: ResponseRow[];
}

export type ResponseFormat = { type: 'text' } | RecordsFormat;

export interface AppSummary {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  group?: string;
  fields: FieldDefinition[];
  /** 이 중 최소 하나는 입력되어야 실행 가능 */
  requireOneOf: string[];
  responseFormat: ResponseFormat;
  hasTools: boolean;
  /** VPC 내부 자원을 씀 — 연결 전에는 실행이 잠긴다. */
  requiresVpn: boolean;
}

export type StreamEvent =
  | { type: 'start'; appId: string }
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; preview: string; ms: number }
  | { type: 'done'; usage?: { iterations: number } }
  | { type: 'error'; message: string };

export interface ToolLogEntry {
  id: string;
  name: string;
  input: unknown;
  status: 'running' | 'ok' | 'error';
  preview?: string;
  ms?: number;
}

/** 서버의 VpnStatus 와 같은 모양 (server/src/vpn/vpn.types.ts) */
export interface VpnStatus {
  configured: boolean;
  endpointResolvable: boolean | null;
  tunnel: 'down' | 'starting' | 'up';
  dbReachable: boolean | null;
}
