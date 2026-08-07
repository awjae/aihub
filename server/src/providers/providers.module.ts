import { Module } from '@nestjs/common';

import { AppConfigModule } from '../config/config.module';
import { AppConfig, CONFIG } from '../config/configuration';
import { OpenAiProvider } from './openai.provider';
import { ProviderRegistry } from './provider.registry';

/**
 * 프로바이더는 하나뿐이다 (OpenAI 호환).
 * 다른 벤더를 붙이려면 ProviderSession 을 구현한 클래스를 만들어 여기에 등록한다 —
 * 공용 메시지 타입으로 변환하는 계층을 두지 말 것 (CLAUDE.md 참고).
 */
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: OpenAiProvider,
      inject: [CONFIG],
      useFactory: (config: AppConfig) => new OpenAiProvider('openai', config),
    },
    {
      provide: ProviderRegistry,
      inject: [OpenAiProvider],
      useFactory: (openai: OpenAiProvider) => new ProviderRegistry(openai),
    },
  ],
  exports: [ProviderRegistry],
})
export class ProvidersModule {}
