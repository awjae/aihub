import { ChatRequest, ProviderEvent, ToolCall } from '../common/types';

export interface ToolResult {
  call: ToolCall;
  content: string;
  isError: boolean;
}

/**
 * 한 번의 대화(요청)를 담당하는 세션.
 *
 * 히스토리는 각 어댑터가 벤더 네이티브 포맷으로 들고 있는다.
 * 중립 포맷으로 왕복시키면 벤더 고유 블록(예: reasoning)처럼
 * 다음 턴에 그대로 돌려줘야 하는 정보가 유실되기 때문.
 */
export interface ProviderSession {
  /** 모델을 한 턴 호출하고 스트림을 흘린다. 종료 시 assistant 메시지를 히스토리에 넣는다. */
  runTurn(signal: AbortSignal): AsyncGenerator<ProviderEvent>;
  /** 툴 실행 결과를 히스토리에 넣는다. 다음 runTurn 에서 모델이 읽는다. */
  addToolResults(results: ToolResult[]): void;
}

export interface ChatProvider {
  readonly name: string;
  createSession(request: ChatRequest): ProviderSession;
}
