import { Module } from '@nestjs/common';

import { AppConfig, CONFIG } from '../config/configuration';
import { AnthropicProvider } from './anthropic.provider';
import { OpenAiProvider } from './openai.provider';
import { ProviderRegistry } from './provider.registry';

@Module({
  providers: [
    {
      provide: AnthropicProvider,
      useFactory: (config: AppConfig) => new AnthropicProvider(config),
      inject: [CONFIG],
    },
    {
      provide: 'OPENAI_PROVIDER',
      useFactory: (config: AppConfig) => new OpenAiProvider('openai', config),
      inject: [CONFIG],
    },
    {
      provide: 'AZURE_PROVIDER',
      useFactory: (config: AppConfig) => new OpenAiProvider('azure', config),
      inject: [CONFIG],
    },
    {
      provide: ProviderRegistry,
      useFactory: (anthropic: AnthropicProvider, openai: OpenAiProvider, azure: OpenAiProvider) =>
        new ProviderRegistry(anthropic, openai, azure),
      inject: [AnthropicProvider, 'OPENAI_PROVIDER', 'AZURE_PROVIDER'],
    },
  ],
  exports: [ProviderRegistry],
})
export class ProvidersModule {}
