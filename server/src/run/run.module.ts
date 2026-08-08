import { Module } from '@nestjs/common';

import { AppsModule } from '../apps/apps.module';
import { ProvidersModule } from '../providers/providers.module';
import { QueryModule } from '../query/query.module';
import { ChatService } from './chat.service';
import { DirectService } from './direct.service';
import { RunController } from './run.controller';

/** 앱 실행(POST /api/run/:appId). 실행기는 앱의 mode 로 고른다. */
@Module({
  imports: [AppsModule, ProvidersModule, QueryModule],
  controllers: [RunController],
  providers: [ChatService, DirectService],
})
export class RunModule {}
