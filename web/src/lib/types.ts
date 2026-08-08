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
  /** query 면 답변 문장 없이 결과를 표로 그린다. */
  mode: 'model' | 'query';
  /** VPC 내부 자원을 씀 — 연결 전에는 실행이 잠긴다. */
  requiresVpn: boolean;
}

export type StreamEvent =
  | { type: 'start'; appId: string }
  | { type: 'text'; text: string }
  | { type: 'step'; name: string; message: string }
  | { type: 'data'; data: unknown }
  | { type: 'done'; usage?: { ms: number } }
  | { type: 'error'; message: string };

/** 진행 단계 표시용. 조회처럼 여러 초 걸리는 작업에서 멈춘 게 아님을 보여준다. */
export interface StepEntry {
  name: string;
  message: string;
}

/** 서버의 VpnStatus 와 같은 모양 (server/src/vpn/vpn.types.ts) */
export interface VpnStatus {
  configured: boolean;
  endpointResolvable: boolean | null;
  tunnel: 'down' | 'starting' | 'up';
  dbReachable: boolean | null;
}

/** direct 모드 툴이 돌려주는 구조체 (akita_schema 의 toStructuredAnswer). */
export type DirectQueryResult =
  | {
      executed: true;
      question: string;
      sql: string;
      parameters: unknown[];
      columns: string[];
      rows: Record<string, unknown>[];
      rowCount: number;
      truncated: boolean;
    }
  | {
      executed: false;
      question: string;
      sql: string;
      parameters: unknown[];
      reason?: string;
    };
