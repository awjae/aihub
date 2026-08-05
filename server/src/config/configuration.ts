import { resolve } from 'node:path';

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface AppConfig {
  port: number;
  corsOrigin: string;
  appsConfigPath: string;
  mcpConfigPath: string;
  maxToolIterations: number;
  mcpToolTimeoutMs: number;
  maxToolResultChars: number;
  anthropic: { apiKey?: string; baseURL?: string };
  openai: { apiKey?: string; baseURL?: string };
  azure: { apiKey?: string; endpoint?: string; apiVersion: string };
}

export function loadConfiguration(): AppConfig {
  return {
    port: int(process.env.PORT, 3000),
    corsOrigin: process.env.CORS_ORIGIN ?? '*',
    appsConfigPath: resolve(process.env.APPS_CONFIG_PATH ?? './config/apps.json'),
    mcpConfigPath: resolve(process.env.MCP_CONFIG_PATH ?? './config/mcp.json'),
    maxToolIterations: int(process.env.MAX_TOOL_ITERATIONS, 8),
    mcpToolTimeoutMs: int(process.env.MCP_TOOL_TIMEOUT_MS, 60_000),
    maxToolResultChars: int(process.env.MAX_TOOL_RESULT_CHARS, 20_000),
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY || undefined,
      baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || undefined,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
    },
    azure: {
      apiKey: process.env.AZURE_OPENAI_API_KEY || undefined,
      endpoint: process.env.AZURE_OPENAI_ENDPOINT || undefined,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
    },
  };
}

export const CONFIG = 'APP_CONFIG';
