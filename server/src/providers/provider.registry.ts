import { Injectable } from '@nestjs/common';

import { ProviderName } from '../common/types';
import { OpenAiProvider } from './openai.provider';
import { ChatProvider } from './provider.interface';

@Injectable()
export class ProviderRegistry {
  private readonly providers: Record<ProviderName, ChatProvider>;

  constructor(openai: OpenAiProvider) {
    this.providers = { openai };
  }

  get(name: ProviderName): ChatProvider {
    const provider = this.providers[name];
    if (!provider) throw new Error(`지원하지 않는 프로바이더입니다: ${name}`);
    return provider;
  }
}
