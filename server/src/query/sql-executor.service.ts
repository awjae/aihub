import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { AppConfig, CONFIG } from '../config/configuration';
import { assertReadOnlySingleStatement } from './read-only-guard';

export interface SqlResult {
  rows: Record<string, unknown>[];
  /** 조건에 맞은 전체 행 수 (maxRows 절삭 전). */
  rowCount: number;
}

/**
 * 생성된 SQL 을 실행한다.
 *
 * 풀을 **게이트웨이가 소유**하는 이유: SQL 을 만드는 쪽(akita_schema)은 질의마다
 * 새 자식 프로세스로 도는데, 거기서 실행하면 커넥션도 매번 새로 맺어야 한다.
 * VPN 너머 RDS 로의 핸드셰이크를 매번 치르지 않도록 여기서 풀을 재사용한다.
 *
 * 읽기 전용을 두 겹으로 막는다:
 *   1) 풀 자체가 `default_transaction_read_only=on` — 서버가 쓰기를 거부한다
 *   2) 단일 SELECT 렉시컬 가드 — 생성기 버그로 다른 게 나와도 실행 전에 막는다
 */
@Injectable()
export class SqlExecutorService implements OnModuleDestroy {
  private readonly logger = new Logger(SqlExecutorService.name);
  private pool: Pool | null = null;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  get configured(): boolean {
    return Boolean(this.config.database.url);
  }

  async execute(sql: string, parameters: unknown[], maxRows: number): Promise<SqlResult> {
    assertReadOnlySingleStatement(sql);

    const client = await this.getPool().connect();
    try {
      const result = await client.query(sql, parameters);
      const rows = (result.rows as Record<string, unknown>[]).slice(0, maxRows);
      return { rows, rowCount: result.rowCount ?? result.rows.length };
    } finally {
      client.release();
    }
  }

  /** 풀은 첫 조회 때 만든다 — VPN 이 없는 동안 커넥션을 시도하지 않도록. */
  private getPool(): Pool {
    if (this.pool) return this.pool;

    const { url, statementTimeoutMs, connectionTimeoutMs } = this.config.database;
    if (!url) throw new Error('DATABASE_URL 이 설정되지 않았습니다.');

    this.pool = new Pool({
      connectionString: url,
      // 서버 쪽 방어. 이 풀이 여는 모든 암묵 트랜잭션이 읽기 전용이 된다.
      options: '-c default_transaction_read_only=on',
      statement_timeout: statementTimeoutMs,
      // VPN 이 내려가면 연결이 매달린다. 기다리게 두지 않고 빨리 실패시킨다.
      connectionTimeoutMillis: connectionTimeoutMs,
    });

    this.pool.on('error', (error) => {
      this.logger.warn(`유휴 커넥션 오류: ${error.message}`);
    });

    return this.pool;
  }
}
