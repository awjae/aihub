import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppsService } from '../apps/apps.service';
import { AppConfig, CONFIG } from '../config/configuration';
import { ProviderRegistry } from '../providers/provider.registry';
import { ChatRequest, StreamEvent } from '../common/types';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly apps: AppsService,
    private readonly providers: ProviderRegistry,
  ) {}

  /**
   * 폼 입력 → 프롬프트 렌더링 → 모델 호출 → 최종 텍스트. SSE 로 흘려보낸다.
   *
   * 툴은 쓰지 않는다. 모델이 툴을 고르는 형태가 필요해지면 그건 이 서비스가
   * 아니라 별도 경로로 만드는 편이 낫다 — 한때 있었고, 안 쓰게 되어 지웠다.
   */
  async *run(
    appId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const resolved = this.apps.get(appId);
    const { app, model } = resolved;
    // direct 모드는 DirectService 가 처리한다 — 컨트롤러가 먼저 갈라내므로
    // 여기까지 오면 라우팅이 잘못된 것이다.
    if (!model) {
      throw new Error(`앱 '${app.id}' 는 query 모드입니다. ChatService 로 오면 안 됩니다.`);
    }
    const prompt = this.apps.renderPrompt(resolved, input);

    yield { type: 'start', appId: app.id };

    const request: ChatRequest = {
      connection: {
        provider: model.provider,
        baseURL: model.baseURL,
        apiKeyEnv: model.apiKeyEnv,
      },
      model: model.model,
      system: model.systemPrompt,
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      maxTokens: model.maxTokens,
    };

    const session = this.providers.get(model.provider).createSession(request);

    for await (const event of session.runTurn(signal)) {
      if (signal.aborted) return;
      if (event.type === 'text') yield { type: 'text', text: event.text };
    }

    yield { type: 'done' };
  }
}
