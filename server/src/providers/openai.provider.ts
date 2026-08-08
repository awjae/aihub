import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import type {
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

import { AppConfig } from '../config/configuration';
import { ChatRequest, ModelConnection, ProviderEvent, ToolCall } from '../common/types';
import { resolveApiKey } from './credentials';
import { ChatProvider, ProviderSession, ToolResult } from './provider.interface';

/**
 * OpenAI 및 OpenAI 호환 엔드포인트(사내 vLLM, LiteLLM 등)를 담당한다.
 * 다른 엔드포인트는 모델 정의의 baseURL·apiKeyEnv 로 지정한다.
 */
@Injectable()
export class OpenAiProvider implements ChatProvider {
  /** 모델마다 엔드포인트·키가 다를 수 있으므로 (baseURL, 키 출처) 조합별로 캐시한다. */
  private readonly clients = new Map<string, OpenAI>();

  constructor(
    readonly name: 'openai',
    private readonly config: AppConfig,
  ) {}

  private getClient(connection: ModelConnection): OpenAI {
    const cacheKey = `${connection.baseURL ?? ''}|${connection.apiKeyEnv ?? ''}`;
    const cached = this.clients.get(cacheKey);
    if (cached) return cached;

    const apiKey = resolveApiKey(connection.apiKeyEnv, this.config.openai.apiKey, 'OPENAI_API_KEY');
    const client = new OpenAI({
      apiKey,
      baseURL: connection.baseURL ?? this.config.openai.baseURL,
    });

    this.clients.set(cacheKey, client);
    return client;
  }

  createSession(request: ChatRequest): ProviderSession {
    return new OpenAiSession(this.getClient(request.connection), request);
  }
}

class OpenAiSession implements ProviderSession {
  private readonly history: ChatCompletionMessageParam[] = [];
  private readonly tools: ChatCompletionTool[];

  constructor(
    private readonly client: OpenAI,
    private readonly request: ChatRequest,
  ) {
    if (request.system) {
      this.history.push({ role: 'system', content: request.system });
    }
    for (const message of request.messages) {
      if (message.role === 'user') {
        this.history.push({ role: 'user', content: message.content });
      }
    }

    this.tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  addToolResults(results: ToolResult[]): void {
    for (const result of results) {
      this.history.push({
        role: 'tool',
        tool_call_id: result.call.id,
        content: result.content,
      });
    }
  }

  async *runTurn(signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.request.model,
        messages: this.history,
        max_completion_tokens: this.request.maxTokens,
        stream: true,
        ...(this.tools.length > 0 ? { tools: this.tools } : {}),
      },
      { signal },
    );

    let text = '';
    // index 기준으로 tool_call 델타를 누적한다. id/name 은 첫 델타에만 오는 경우가 많다.
    const partialCalls = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        text += delta.content;
        yield { type: 'text', text: delta.content };
      }

      for (const call of delta.tool_calls ?? []) {
        const entry = partialCalls.get(call.index) ?? { id: '', name: '', args: '' };
        if (call.id) entry.id = call.id;
        if (call.function?.name) entry.name += call.function.name;
        if (call.function?.arguments) entry.args += call.function.arguments;
        partialCalls.set(call.index, entry);
      }
    }

    const rawCalls: ChatCompletionMessageFunctionToolCall[] = [...partialCalls.values()].map((entry) => ({
      id: entry.id,
      type: 'function',
      function: { name: entry.name, arguments: entry.args },
    }));

    this.history.push({
      role: 'assistant',
      content: text || null,
      ...(rawCalls.length > 0 ? { tool_calls: rawCalls } : {}),
    });

    const toolCalls = rawCalls.map<ToolCall>((call) => ({
      id: call.id,
      name: call.function.name,
      input: safeParseArgs(call.function.arguments),
    }));

    yield { type: 'turn_end', assistant: { content: text, toolCalls } };
  }
}

/** 모델이 깨진 JSON 을 뱉을 수 있으므로 파싱 실패를 던지지 않는다. */
function safeParseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { __parse_error: raw };
  }
}
