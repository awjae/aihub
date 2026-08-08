import { Logger } from '@nestjs/common';
import { ChildProcess, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TunnelState } from './vpn.types';

/** openvpn 이 터널을 다 세웠을 때 남기는 마지막 줄. 이걸로 up 을 판정한다. */
const READY_LINE = 'Initialization Sequence Completed';

/** 재연결로 넘어갔음을 알리는 줄. up 이었다면 끊긴 것이다. */
const RECONNECTING = /Restart pause|SIGUSR1|Connection reset|TLS Error/i;

/** 프로세스가 통째로 죽었을 때 다시 띄우기까지의 간격. */
const RESPAWN_DELAY_MS = 10_000;

/**
 * AWS 가 내려주는 Client VPN 설정에는 와일드카드가 들어 있다.
 *
 *   remote *.cvpn-endpoint-xxxx.prod.clientvpn.<region>.amazonaws.com 443
 *   remote-random-hostname
 *
 * `remote-random-hostname` 이 무작위 접두어를 붙이는데 `*.` 가 남아 있으면
 * `랜덤.*.cvpn-endpoint-…` 라는 존재할 수 없는 이름이 되어 DNS 가 실패한다.
 * 상호 인증(mutual auth)에서 AWS 가 "임의 문자열을 앞에 붙이라"고 안내하는 그
 * 자리이므로, `*.` 만 걷어내면 openvpn 이 알아서 채운다.
 *
 * 콘솔에서 새로 받은 파일도 같은 상태이므로 손으로 고치지 않고 여기서 정규화한다.
 */
export function normalizeOvpnConfig(contents: string): string {
  return contents.replace(/^(\s*remote\s+)\*\./gm, '$1');
}

/**
 * .ovpn 의 remote 호스트. 서브넷이 연결돼 있을 때만 이 이름이 DNS 에 게시되므로,
 * **AWS 자격증명 없이도** 해석 여부만으로 VPN 을 쓸 수 있는 상태인지 알 수 있다.
 */
export function readEndpointHost(configPath: string): string | null {
  const match = readFileSync(configPath, 'utf8').match(/^\s*remote\s+(\S+)/m);
  return match ? match[1].replace(/^\*\./, '') : null;
}

/**
 * 컨테이너 안 openvpn 프로세스 하나를 관리한다.
 *
 * --daemon 을 쓰지 않는다: 데몬으로 띄우면 자식 핸들을 잃어 종료·상태 추적을
 * PID 파일에 의존해야 하고, 컨테이너가 죽을 때 터널만 남는 경우가 생긴다.
 * 포그라운드로 붙들고 있으면 게이트웨이가 죽을 때 터널도 같이 정리된다.
 */
export class OpenVpnProcess {
  private readonly logger = new Logger(OpenVpnProcess.name);
  private child: ChildProcess | null = null;
  private state: TunnelState = 'down';
  /** 정상 종료(서버 내려감)인지 — 그때는 재시작하지 않는다. */
  private stopped = false;
  private readonly recentLines: string[] = [];

  constructor(
    private readonly configPath: string,
    private readonly binary = 'openvpn',
  ) {}

  getState(): TunnelState {
    return this.state;
  }


  /**
   * openvpn 을 띄우고 그대로 둔다.
   *
   * VPN 이 꺼져 있으면 붙지 못하는 게 정상이므로 실패로 보지 않는다 —
   * `.ovpn` 의 `resolv-retry infinite` 가 백오프하며 계속 재시도하고,
   * 개발자가 VPN 을 켜는 순간 스스로 붙는다. 프로세스가 통째로 죽은 경우에만
   * 다시 띄운다.
   */
  startAndKeepRetrying(): void {
    if (this.child !== null) return;

    let configPath: string;
    try {
      configPath = this.materializeConfig();
    } catch (error) {
      this.state = 'down';
      this.logger.error(`.ovpn 을 읽지 못했습니다 (${this.configPath}): ${asMessage(error)}`);
      return;
    }

    this.state = 'starting';
    const child = spawn(this.binary, ['--config', configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    const consume = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;

        this.recentLines.push(trimmed);
        if (this.recentLines.length > 40) this.recentLines.shift();

        if (trimmed.includes(READY_LINE)) {
          this.state = 'up';
          this.logger.log('VPN 터널 연결됨');
        } else if (RECONNECTING.test(trimmed)) {
          if (this.state === 'up') this.logger.warn('VPN 터널 끊김 — 재시도합니다');
          this.state = 'starting';
        }
      }
    };

    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);

    child.on('error', (error) => {
      this.state = 'down';
      this.child = null;
      this.logger.error(
        `openvpn 을 실행하지 못했습니다: ${error.message}. ` +
          '컨테이너에 NET_ADMIN·/dev/net/tun 이 있는지 확인하세요.',
      );
    });

    child.on('exit', (code, signal) => {
      this.state = 'down';
      this.child = null;
      if (this.stopped) return;

      // openvpn 은 자체 재시도로 버티므로 여기까지 오면 비정상 종료다.
      this.logger.warn(
        `openvpn 종료 (code=${code}, signal=${signal}) — ${RESPAWN_DELAY_MS / 1000}초 후 재시작`,
      );
      setTimeout(() => this.startAndKeepRetrying(), RESPAWN_DELAY_MS).unref();
    });
  }

  /**
   * 정규화한 사본을 만들어 그 경로를 돌려준다.
   * 원본은 config/ 에 읽기 전용으로 마운트되므로 제자리에서 고칠 수 없고,
   * 고쳐서도 안 된다 — 사용자가 넣어둔 파일은 그대로 두는 편이 덜 놀랍다.
   */
  private materializeConfig(): string {
    const normalized = normalizeOvpnConfig(readFileSync(this.configPath, 'utf8'));
    const target = join(tmpdir(), 'akita-vpn.ovpn');
    writeFileSync(target, normalized, { mode: 0o600 });
    return target;
  }

  /**
   * 백오프를 초기화하고 즉시 다시 붙어 본다.
   *
   * openvpn 은 실패할수록 재시도 간격을 2배로 늘려 최대 5분까지 벌린다. VPN 이
   * 막 켜졌는데 그만큼 기다리는 건 사용자가 납득하기 어려우므로, 프로세스를
   * 새로 띄워 간격을 처음으로 되돌린다.
   */
  restart(): void {
    this.terminate();
    this.startAndKeepRetrying();
  }

  stop(): void {
    this.stopped = true;
    this.terminate();
  }

  private terminate(): void {
    if (this.child) this.child.kill('SIGTERM');
    this.child = null;
    this.state = 'down';
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
