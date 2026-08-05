import { BadRequestException, Controller, Get, Logger, Param, Post } from '@nestjs/common';

import { AppsService } from './apps.service';
import { PublicAppDefinition, toPublic } from './app-definition';

@Controller('api/apps')
export class AppsController {
  private readonly logger = new Logger(AppsController.name);

  constructor(private readonly apps: AppsService) {}

  @Get()
  list(): { apps: PublicAppDefinition[] } {
    return { apps: this.apps.list().map(toPublic) };
  }

  @Get(':id')
  get(@Param('id') id: string): PublicAppDefinition {
    return toPublic(this.apps.get(id));
  }

  // reload 는 아래 — 라우트 순서상 :id 보다 뒤여도 method 가 달라 충돌하지 않는다.

  /**
   * apps.yaml 을 다시 읽는다. 배포 없이 앱을 추가·수정할 때 사용.
   * 실패해도 기존 정의는 그대로 유지되며, 어디가 잘못됐는지 그대로 돌려준다.
   */
  @Post('reload')
  reload(): { models: number; apps: number } {
    try {
      const result = this.apps.load();
      this.logger.log(`설정 리로드: 모델 ${result.models}개, 앱 ${result.apps}개`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`앱 정의 리로드 실패 (기존 정의 유지): ${message}`);
      throw new BadRequestException(message);
    }
  }
}
