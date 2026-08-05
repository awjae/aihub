import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppsService } from '../apps/apps.service';
import { AppConfig, CONFIG } from '../config/configuration';
import { McpService } from '../mcp/mcp.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { ToolResult } from '../providers/provider.interface';
import { ChatRequest, StreamEvent, ToolCall } from '../common/types';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly apps: AppsService,
    private readonly mcp: McpService,
    private readonly providers: ProviderRegistry,
  ) {}

  /**
   * 폼 입력 → 프롬프트 렌더링 → 모델 호출 → (툴 호출 → 실행 → 재호출) 루프 → 최종 텍스트.
   * 각 단계를 SSE 이벤트로 흘려보낸다.
   */
  async *run(
    appId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const resolved = this.apps.get(appId);
    const { app, model } = resolved;
    const prompt = this.apps.renderPrompt(resolved, input);

    yield { type: 'start', appId: app.id };

    const tools = app.mcpServers.length > 0 ? await this.mcp.listTools(app.mcpServers) : [];

    const request: ChatRequest = {
      connection: {
        provider: model.provider,
        baseURL: model.baseURL,
        apiKeyEnv: model.apiKeyEnv,
      },
      model: model.model,
      system: model.systemPrompt,
      messages: [{ role: 'user', content: prompt }],
      tools,
      maxTokens: model.maxTokens,
      thinking: model.thinking,
      effort: model.effort,
    };

    const session = this.providers.get(model.provider).createSession(request);
    let iterations = 0;

    while (iterations < this.config.maxToolIterations) {
      iterations += 1;
      let pendingCalls: ToolCall[] = [];

      for await (const event of session.runTurn(signal)) {
        if (signal.aborted) return;

        switch (event.type) {
          case 'text':
            yield { type: 'text', text: event.text };
            break;
          case 'reasoning':
            yield { type: 'reasoning', text: event.text };
            break;
          case 'turn_end':
            pendingCalls = event.assistant.toolCalls;
            break;
        }
      }

      if (pendingCalls.length === 0) {
        yield { type: 'done', usage: { iterations } };
        return;
      }

      for (const call of pendingCalls) {
        yield { type: 'tool_call', id: call.id, name: call.name, input: call.input };
      }

      // 모델이 여러 툴을 한 번에 요청하면 병렬로 실행한다.
      const results = await Promise.all(
        pendingCalls.map(async (call): Promise<{ result: ToolResult; ms: number }> => {
          const startedAt = Date.now();
          const { ok, content } = await this.mcp.callTool(call.name, call.input);
          return {
            result: { call, content, isError: !ok },
            ms: Date.now() - startedAt,
          };
        }),
      );

      for (const { result, ms } of results) {
        yield {
          type: 'tool_result',
          id: result.call.id,
          name: result.call.name,
          ok: !result.isError,
          preview: result.content.slice(0, 500),
          ms,
        };
      }

      session.addToolResults(results.map((r) => r.result));
    }

    // 루프 상한에 걸린 경우 — 무한 루프 방지용 안전장치.
    this.logger.warn(`앱 '${app.id}': 툴 루프 상한(${this.config.maxToolIterations}회)에 도달했습니다.`);
    yield {
      type: 'error',
      message: `툴 호출이 ${this.config.maxToolIterations}회를 넘어 중단했습니다. 질문을 더 구체적으로 바꿔 다시 시도해 주세요.`,
    };
  }
}
