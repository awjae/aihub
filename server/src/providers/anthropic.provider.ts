import Anthropic from '@anthropic-ai/sdk';
import { Injectable } from '@nestjs/common';

import { AppConfig } from '../config/configuration';
import { ChatRequest, ModelConnection, ProviderEvent, ToolCall } from '../common/types';
import { resolveApiKey } from './credentials';
import { ChatProvider, ProviderSession, ToolResult } from './provider.interface';

/** thinking 을 끌 수 있는 최대 effort. 그 이상에서는 disabled 가 400 을 낸다. */
const THINKING_DISABLE_MAX_EFFORT = new Set(['low', 'medium', 'high']);

@Injectable()
export class AnthropicProvider implements ChatProvider {
  readonly name = 'anthropic';
  /** 모델마다 엔드포인트·키가 다를 수 있으므로 (baseURL, 키 출처) 조합별로 캐시한다. */
  private readonly clients = new Map<string, Anthropic>();

  constructor(private readonly config: AppConfig) {}

  private getClient(connection: ModelConnection): Anthropic {
    const cacheKey = `${connection.baseURL ?? ''}|${connection.apiKeyEnv ?? ''}`;
    const cached = this.clients.get(cacheKey);
    if (cached) return cached;

    const client = new Anthropic({
      apiKey: resolveApiKey(connection.apiKeyEnv, this.config.anthropic.apiKey, 'ANTHROPIC_API_KEY'),
      baseURL: connection.baseURL ?? this.config.anthropic.baseURL,
    });

    this.clients.set(cacheKey, client);
    return client;
  }

  createSession(request: ChatRequest): ProviderSession {
    return new AnthropicSession(this.getClient(request.connection), request);
  }
}

class AnthropicSession implements ProviderSession {
  private readonly history: Anthropic.MessageParam[] = [];
  private readonly tools: Anthropic.Tool[];

  constructor(
    private readonly client: Anthropic,
    private readonly request: ChatRequest,
  ) {
    for (const message of request.messages) {
      if (message.role === 'user') {
        this.history.push({ role: 'user', content: message.content });
      }
    }

    this.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }));
  }

  addToolResults(results: ToolResult[]): void {
    // Anthropic 은 tool_result 들을 한 개의 user 메시지에 모아서 보내야 한다.
    this.history.push({
      role: 'user',
      content: results.map<Anthropic.ToolResultBlockParam>((result) => ({
        type: 'tool_result',
        tool_use_id: result.call.id,
        content: result.content,
        is_error: result.isError,
      })),
    });
  }

  async *runTurn(signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const params: Anthropic.MessageCreateParamsStreaming = {
      model: this.request.model,
      max_tokens: this.request.maxTokens,
      messages: this.history,
      stream: true,
    };

    if (this.request.system) params.system = this.request.system;
    if (this.tools.length > 0) params.tools = this.tools;

    const effort = this.request.effort;
    if (effort) params.output_config = { effort };

    if (this.request.thinking === 'disabled') {
      // xhigh / max 와 disabled 조합은 400 이므로 그때는 그냥 모델 기본값에 맡긴다.
      if (!effort || THINKING_DISABLE_MAX_EFFORT.has(effort)) {
        params.thinking = { type: 'disabled' };
      }
    } else {
      // 기본값. display 를 켜야 "생각 중" 진행 상황을 사용자에게 보여줄 수 있다.
      params.thinking = { type: 'adaptive', display: 'summarized' };
    }

    const stream = this.client.messages.stream(params, { signal });

    for await (const event of stream) {
      if (event.type !== 'content_block_delta') continue;
      if (event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text };
      } else if (event.delta.type === 'thinking_delta') {
        yield { type: 'reasoning', text: event.delta.thinking };
      }
    }

    const final = await stream.finalMessage();

    // thinking / tool_use 블록을 포함해 응답 전체를 그대로 히스토리에 넣는다.
    // 편집하면 다음 턴에서 서명 검증에 실패한다.
    this.history.push({ role: 'assistant', content: final.content });

    const text = final.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const toolCalls = final.content
      .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
      .map<ToolCall>((block) => ({
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      }));

    if (final.stop_reason === 'refusal') {
      throw new Error('모델이 안전 정책에 따라 이 요청에 답변하지 않았습니다.');
    }

    yield { type: 'turn_end', assistant: { content: text, toolCalls } };
  }
}
