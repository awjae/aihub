import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { AppConfig, CONFIG } from '../config/configuration';
import { parseJsonc } from '../apps/jsonc';
import { ToolDefinition } from '../common/types';

interface StdioServerConfig {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
}

interface HttpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  disabled?: boolean;
}

type ServerConfig = StdioServerConfig | HttpServerConfig;

/** 툴 이름은 `<서버>__<툴>` 로 네임스페이싱해서 서버 간 충돌을 막는다. */
const NAME_SEPARATOR = '__';

@Injectable()
export class McpService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(McpService.name);
  private servers = new Map<string, ServerConfig>();
  private clients = new Map<string, Client>();
  private connecting = new Map<string, Promise<Client>>();

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  onModuleInit(): void {
    this.loadConfig();
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map((c) => c.close()));
    this.clients.clear();
  }

  private loadConfig(): void {
    const path = this.config.mcpConfigPath;
    if (!existsSync(path)) {
      this.logger.warn(`MCP 설정 파일이 없습니다 (${path}). 툴 없이 동작합니다.`);
      return;
    }

    const parsed = parseJsonc(readFileSync(path, 'utf8'), path) as {
      mcpServers?: Record<string, unknown>;
    };
    const entries = Object.entries(parsed.mcpServers ?? {});

    for (const [name, raw] of entries) {
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        this.logger.error(`MCP 서버 이름 '${name}' 은 영문·숫자·하이픈·언더스코어만 허용됩니다. 건너뜁니다.`);
        continue;
      }
      const cfg = this.expandEnv(raw) as ServerConfig;
      if (cfg.disabled) {
        this.logger.log(`MCP 서버 '${name}' — disabled, 건너뜀`);
        continue;
      }
      this.servers.set(name, cfg);
    }

    this.logger.log(
      this.servers.size > 0
        ? `MCP 서버 ${this.servers.size}개 등록: ${[...this.servers.keys()].join(', ')}`
        : 'MCP 서버 없음 (툴 미사용)',
    );
  }

  /** 문자열 값 안의 ${VAR} 를 환경변수로 치환한다. */
  private expandEnv(value: unknown): unknown {
    if (typeof value === 'string') {
      return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (match, key: string) => process.env[key] ?? match);
    }
    if (Array.isArray(value)) return value.map((v) => this.expandEnv(v));
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.expandEnv(v)]));
    }
    return value;
  }

  /**
   * 지정한 서버들의 툴 목록을 모아서 모델에 넘길 수 있는 형태로 반환한다.
   * 연결에 실패한 서버는 로그만 남기고 건너뛴다 — 툴 하나 때문에 앱 전체가 죽지 않도록.
   */
  async listTools(serverNames: string[]): Promise<ToolDefinition[]> {
    const tools: ToolDefinition[] = [];

    for (const name of serverNames) {
      if (!this.servers.has(name)) {
        this.logger.error(`앱이 참조한 MCP 서버 '${name}' 가 mcp.json 에 없습니다.`);
        continue;
      }

      try {
        const client = await this.getClient(name);
        const result = await client.listTools();
        for (const tool of result.tools) {
          tools.push({
            name: `${name}${NAME_SEPARATOR}${tool.name}`,
            description: tool.description ?? tool.name,
            inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {
              type: 'object',
              properties: {},
            },
          });
        }
      } catch (error) {
        this.logger.error(`MCP 서버 '${name}' 툴 목록 조회 실패: ${asMessage(error)}`);
      }
    }

    return tools;
  }

  /** 모델이 요청한 툴을 실제로 실행한다. 실패해도 던지지 않고 에러 문자열을 돌려준다. */
  async callTool(
    prefixedName: string,
    input: Record<string, unknown>,
  ): Promise<{ ok: boolean; content: string }> {
    const separatorIndex = prefixedName.indexOf(NAME_SEPARATOR);
    if (separatorIndex === -1) {
      return { ok: false, content: `알 수 없는 툴 이름입니다: ${prefixedName}` };
    }

    const serverName = prefixedName.slice(0, separatorIndex);
    const toolName = prefixedName.slice(separatorIndex + NAME_SEPARATOR.length);

    if (!this.servers.has(serverName)) {
      return { ok: false, content: `등록되지 않은 MCP 서버입니다: ${serverName}` };
    }

    try {
      const client = await this.getClient(serverName);
      const result = await client.callTool(
        { name: toolName, arguments: input },
        undefined,
        { timeout: this.config.mcpToolTimeoutMs },
      );

      const text = this.flatten(result.content);
      const truncated =
        text.length > this.config.maxToolResultChars
          ? `${text.slice(0, this.config.maxToolResultChars)}\n…(결과가 길어 잘렸습니다)`
          : text;

      return { ok: result.isError !== true, content: truncated };
    } catch (error) {
      const message = asMessage(error);
      this.logger.error(`툴 '${prefixedName}' 실행 실패: ${message}`);
      // 모델이 대안을 찾을 수 있도록 에러를 그대로 툴 결과로 돌려준다.
      return { ok: false, content: `툴 실행 오류: ${message}` };
    }
  }

  private flatten(content: unknown): string {
    if (!Array.isArray(content)) return typeof content === 'string' ? content : JSON.stringify(content);

    return content
      .map((block: Record<string, unknown>) => {
        if (block?.type === 'text') return String(block.text ?? '');
        if (block?.type === 'resource') return JSON.stringify(block.resource);
        return `[${String(block?.type ?? 'unknown')} 컨텐츠는 텍스트로 변환할 수 없습니다]`;
      })
      .join('\n')
      .trim();
  }

  /** 서버당 커넥션 1개를 재사용한다. 동시 요청이 겹쳐도 커넥션은 하나만 뜨도록 잠근다. */
  private async getClient(name: string): Promise<Client> {
    const existing = this.clients.get(name);
    if (existing) return existing;

    const inFlight = this.connecting.get(name);
    if (inFlight) return inFlight;

    const promise = this.connect(name)
      .then((client) => {
        this.clients.set(name, client);
        this.connecting.delete(name);
        return client;
      })
      .catch((error) => {
        this.connecting.delete(name);
        throw error;
      });

    this.connecting.set(name, promise);
    return promise;
  }

  private async connect(name: string): Promise<Client> {
    const cfg = this.servers.get(name) as ServerConfig;
    const client = new Client({ name: 'aihub-gateway', version: '1.0.0' });

    if (cfg.type === 'stdio') {
      await client.connect(
        new StdioClientTransport({
          command: cfg.command,
          args: cfg.args ?? [],
          env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
        }),
      );
    } else {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(cfg.url), {
          requestInit: { headers: cfg.headers ?? {} },
        }),
      );
    }

    // 커넥션이 끊기면 캐시에서 제거해 다음 요청에서 재연결되게 한다.
    client.onclose = () => {
      this.logger.warn(`MCP 서버 '${name}' 연결이 종료되었습니다.`);
      this.clients.delete(name);
    };

    this.logger.log(`MCP 서버 '${name}' 연결됨`);
    return client;
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
