import { resolve } from 'node:path';

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface AppConfig {
  port: number;
  corsOrigin: string;
  appsConfigPath: string;
  /** 질문을 SQL 로 바꾸는 CLI 의 진입 파일 (akita_schema). 질의마다 새로 띄운다. */
  queryCliEntry?: string;
  database: DatabaseConfig;
  maxRows: number;
  openai: { apiKey?: string; baseURL?: string };
  vpn: VpnConfig;
}

export interface DatabaseConfig {
  url?: string;
  statementTimeoutMs: number;
  /** VPN 이 내려가면 커넥션이 매달린다. 빨리 실패시켜 사용자를 기다리게 하지 않는다. */
  connectionTimeoutMs: number;
}

/**
 * Client VPN. VPC 밖에서 게이트웨이를 띄울 때만 씁니다.
 * ovpnConfig 파일이 없으면 기능 전체가 꺼진 것으로 봅니다 — 그 편이 안전한 기본값입니다.
 */
export interface VpnConfig {
  ovpnConfig?: string;
  /** 도달 확인 대상. 비우면 DATABASE_URL 에서 뽑습니다. */
  probeTarget?: string;
}

export function loadConfiguration(): AppConfig {
  return {
    port: int(process.env.PORT, 3000),
    corsOrigin: process.env.CORS_ORIGIN ?? '*',
    appsConfigPath: resolve(process.env.APPS_CONFIG_PATH ?? './config/apps.json'),
    openai: {
      apiKey: process.env.OPENAI_API_KEY || undefined,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
    },
    queryCliEntry: process.env.AKITA_QUERY_CLI || undefined,
    database: {
      url: process.env.DATABASE_URL || undefined,
      statementTimeoutMs: int(process.env.DATABASE_QUERY_TIMEOUT_MS, 15_000),
      connectionTimeoutMs: int(process.env.DATABASE_CONNECT_TIMEOUT_MS, 5_000),
    },
    maxRows: int(process.env.MAX_ROWS, 50),
    vpn: {
      ovpnConfig: process.env.VPN_OVPN_CONFIG || undefined,
      probeTarget: process.env.VPN_PROBE_TARGET || undefined,
    },
  };
}

export const CONFIG = 'APP_CONFIG';
