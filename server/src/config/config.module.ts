import { Global, Module } from '@nestjs/common';

import { CONFIG, loadConfiguration } from './configuration';

/**
 * 환경변수를 한 번만 읽어 AppConfig 객체로 만들어 전역 제공한다.
 * 인터페이스는 DI 토큰이 될 수 없으므로 CONFIG 심볼로 주입받는다.
 */
@Global()
@Module({
  providers: [{ provide: CONFIG, useFactory: loadConfiguration }],
  exports: [CONFIG],
})
export class AppConfigModule {}
