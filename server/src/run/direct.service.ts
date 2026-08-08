import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppsService } from '../apps/apps.service';
import { AppConfig, CONFIG } from '../config/configuration';
import { QueryBuilderService, QueryBuildError } from '../query/query-builder.service';
import { SqlExecutorService } from '../query/sql-executor.service';
import { StreamEvent } from '../common/types';

/**
 * 모델을 거치지 않는 실행 경로.
 *
 * 질문을 SQL 로 바꾸는 데만 LLM 이 쓰이고(자식 프로세스 안), 실행과 표시는 전부
 * 여기서 끝난다. **조회 결과는 어떤 프롬프트에도 들어가지 않는다** — 그게 이
 * 경로가 존재하는 이유다.
 */
@Injectable()
export class DirectService {
  private readonly logger = new Logger(DirectService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly apps: AppsService,
    private readonly builder: QueryBuilderService,
    private readonly executor: SqlExecutorService,
  ) {}

  async *run(
    appId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const resolved = this.apps.get(appId);
    const { app } = resolved;

    // 폼 검증은 model 모드와 같은 규칙을 쓴다 (필수·최소 길이·선택지).
    const question = this.apps.renderQuestion(resolved, input);

    yield { type: 'start', appId: app.id };
    if (signal.aborted) return;

    const startedAt = Date.now();
    yield { type: 'step', name: 'build', message: '질문을 SQL 로 바꾸는 중…' };

    let built;
    try {
      built = await this.builder.build(question);
    } catch (error) {
      yield { type: 'error', message: describeBuildError(error) };
      return;
    }

    if (signal.aborted) return;

    if (!this.executor.configured) {
      // DB 없이도 무엇을 조회할지는 보여준다 — 배선 확인과 데모에 쓸모가 있다.
      yield {
        type: 'data',
        data: {
          executed: false,
          question,
          sql: built.sql,
          parameters: built.parameters,
          reason: 'DATABASE_URL 이 설정되지 않아 SQL 만 만들었습니다.',
        },
      };
      yield { type: 'done', usage: { ms: Date.now() - startedAt } };
      return;
    }

    yield { type: 'step', name: 'execute', message: '조회하는 중…' };

    try {
      const { rows, rowCount } = await this.executor.execute(
        built.sql,
        built.parameters,
        this.config.maxRows,
      );

      yield {
        type: 'data',
        data: {
          executed: true,
          question,
          sql: built.sql,
          parameters: built.parameters,
          columns: rows.length === 0 ? [] : Object.keys(rows[0] as Record<string, unknown>),
          rows,
          rowCount,
          truncated: rows.length < rowCount,
        },
      };
      yield { type: 'done', usage: { ms: Date.now() - startedAt } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`앱 '${app.id}' 조회 실패: ${message}`);
      yield { type: 'error', message: describeExecuteError(message) };
    }
  }
}

function describeBuildError(error: unknown): string {
  if (!(error instanceof QueryBuildError)) {
    return error instanceof Error ? error.message : String(error);
  }

  // 스키마로 답할 수 없는 질문은 사용자가 고쳐 쓸 수 있는 유일한 실패다.
  if (error.code === 'unsupported_query') {
    return `이 질문은 지금 데이터로 답할 수 없습니다.\n${error.message}`;
  }
  return error.message;
}

function describeExecuteError(message: string): string {
  // VPN 이 내려간 경우가 압도적으로 흔하다. 원인을 짚어준다.
  if (/ETIMEDOUT|ENOTFOUND|ECONNREFUSED|timeout expired|Connection terminated/i.test(message)) {
    return `데이터베이스에 연결하지 못했습니다. VPN 연결 상태를 확인하세요.\n${message}`;
  }
  return message;
}
