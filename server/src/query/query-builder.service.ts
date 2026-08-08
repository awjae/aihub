import { Inject, Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';

import { AppConfig, CONFIG } from '../config/configuration';

export interface BuiltQuery {
  question: string;
  sql: string;
  parameters: unknown[];
}

export class QueryBuildError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'QueryBuildError';
  }
}

/** 자식이 살아 있을 수 있는 최대 시간. LLM 호출 한 번이 들어 있다. */
const TIMEOUT_MS = 120_000;
/** 비정상적으로 큰 출력을 붙들지 않기 위한 상한. 정상 응답은 수 KB 다. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * 질문을 SQL 로 바꾼다 — 실행하지 않는다.
 *
 * akita_schema 의 CLI 를 질의마다 새 프로세스로 띄운다. 상주 서버를 두지 않는
 * 이유는 이 작업이 **CPU 작업뿐**이기 때문이다: 스키마 카탈로그를 읽고(실측 14ms,
 * 프로세스 기동까지 90~100ms) LLM 에 계획을 물어 SQL 을 만든다. LLM 왕복이 수 초라
 * 기동 비용은 묻히고, 대신 자식이 크래시해도 게이트웨이가 멀쩡하다.
 *
 * DB 는 건드리지 않으므로 커넥션 재사용 문제도 생기지 않는다 — 실행은
 * `SqlExecutorService` 가 자기 풀로 한다.
 */
@Injectable()
export class QueryBuilderService {
  private readonly logger = new Logger(QueryBuilderService.name);

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  async build(question: string): Promise<BuiltQuery> {
    const entry = this.config.queryCliEntry;
    if (!entry) {
      throw new QueryBuildError(
        'AKITA_QUERY_CLI 가 설정되지 않았습니다.',
        'invalid_configuration',
      );
    }

    const { stdout, stderr, code } = await this.run(entry, question);

    // 성공·실패 모두 한 줄 JSON 이다. 성공은 stdout, 실패는 stderr 로 온다.
    const payload = parseJson(code === 0 ? stdout : stderr);
    if (payload === null) {
      this.logger.error(`질의 생성기가 JSON 을 내지 않았습니다 (code=${code}): ${stderr.slice(0, 500)}`);
      throw new QueryBuildError(
        '질의를 만들지 못했습니다. 서버 로그를 확인하세요.',
        'builder_failed',
      );
    }

    if (payload.ok !== true) {
      throw new QueryBuildError(
        typeof payload.message === 'string' ? payload.message : '질의를 만들지 못했습니다.',
        typeof payload.code === 'string' ? payload.code : 'builder_failed',
      );
    }

    return {
      question,
      sql: String(payload.sql),
      parameters: Array.isArray(payload.parameters) ? payload.parameters : [],
    };
  }

  private run(
    entry: string,
    question: string,
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      // 질문은 인자로 넘긴다 — 셸을 거치지 않으므로 따옴표·세미콜론이 문제되지 않는다.
      const child = spawn(process.execPath, [entry, question, '--json'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(() =>
          reject(
            new QueryBuildError(
              `질의 생성이 ${TIMEOUT_MS / 1000}초 안에 끝나지 않았습니다.`,
              'builder_timeout',
            ),
          ),
        );
      }, TIMEOUT_MS);

      const collect = (target: 'out' | 'err') => (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (target === 'out') {
          if (stdout.length < MAX_OUTPUT_BYTES) stdout += text;
        } else if (stderr.length < MAX_OUTPUT_BYTES) {
          stderr += text;
        }
      };

      child.stdout.on('data', collect('out'));
      child.stderr.on('data', collect('err'));

      child.on('error', (error) =>
        finish(() =>
          reject(new QueryBuildError(`질의 생성기를 실행하지 못했습니다: ${error.message}`, 'builder_spawn_failed')),
        ),
      );
      child.on('close', (code) => finish(() => resolve({ stdout, stderr, code })));
    });
  }
}

function parseJson(raw: string): Record<string, unknown> | null {
  // 마지막 비어 있지 않은 줄만 본다 — 경고가 앞에 섞여 나와도 견딘다.
  const line = raw.trim().split('\n').filter((l) => l.trim() !== '').pop();
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
