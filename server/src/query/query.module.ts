import { Module } from '@nestjs/common';

import { AppConfigModule } from '../config/config.module';
import { QueryBuilderService } from './query-builder.service';
import { SqlExecutorService } from './sql-executor.service';

/** 질문 → SQL(자식 프로세스) → 실행(게이트웨이의 풀). */
@Module({
  imports: [AppConfigModule],
  providers: [QueryBuilderService, SqlExecutorService],
  exports: [QueryBuilderService, SqlExecutorService],
})
export class QueryModule {}
