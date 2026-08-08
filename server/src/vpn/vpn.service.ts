import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { promises as dns } from 'node:dns';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';

import { AppConfig, CONFIG } from '../config/configuration';
import { OpenVpnProcess, readEndpointHost } from './openvpn.process';
import { VpnStatus } from './vpn.types';

const PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_PG_PORT = 5432;

/**
 * 운영 DB 는 VPC 내부에 있고, 거기로 가는 Client VPN 은 **개발자가 직접**
 * `client-vpn.sh production on/off` 로 켜고 끈다 (접속이 없어도 연결 시간만큼
 * 과금되므로 온디맨드 — EMR-56246).
 *
 * 그래서 이 서비스는 서브넷을 조작하지 않는다. 터널도 **필요할 때만** 세운다 —
 * 아무도 데이터 질의를 쓰지 않는데 터널을 붙들고 있을 이유가 없다.
 *
 * 접속을 시도하는 계기는 둘뿐이다:
 *   1) 사용자가 VPN 이 필요한 앱을 열었을 때
 *   2) "다시 확인" 을 눌렀을 때
 * 둘 다 `recheck()` 로 들어온다. `status()` 는 폴링용이라 아무 것도 바꾸지 않는다.
 */
@Injectable()
export class VpnService implements OnModuleDestroy {
  private readonly logger = new Logger(VpnService.name);
  private readonly tunnel: OpenVpnProcess | null;
  /** .ovpn 에서 뽑은 엔드포인트 호스트. DNS 해석으로 VPN 이 켜졌는지 본다. */
  private readonly endpointHost: string | null;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    const { vpn } = config;

    if (!vpn.ovpnConfig || !existsSync(vpn.ovpnConfig)) {
      this.logger.log(
        vpn.ovpnConfig
          ? `VPN 비활성 — .ovpn 파일이 없습니다 (${vpn.ovpnConfig}).`
          : 'VPN 비활성 — VPN_OVPN_CONFIG 가 설정되지 않았습니다.',
      );
      this.tunnel = null;
      this.endpointHost = null;
      return;
    }

    this.tunnel = new OpenVpnProcess(vpn.ovpnConfig);
    this.endpointHost = readEndpointHost(vpn.ovpnConfig);
    this.logger.log(`VPN 활성 (endpoint=${this.endpointHost ?? '알 수 없음'})`);
  }

  onModuleDestroy(): void {
    this.tunnel?.stop();
  }

  async status(): Promise<VpnStatus> {
    if (!this.tunnel) {
      return {
        configured: false,
        endpointResolvable: null,
        tunnel: 'down',
        dbReachable: null,
      };
    }

    const [endpointResolvable, dbReachable] = await Promise.all([
      this.probeEndpointDns(),
      this.probeTarget(),
    ]);

    return {
      configured: true,
      endpointResolvable,
      tunnel: this.tunnel.getState(),
      dbReachable,
    };
  }

  /**
   * 접속을 시도하는 유일한 진입점 — 앱을 열었을 때와 "다시 확인" 을 눌렀을 때.
   *
   * VPN 이 꺼져 있으면(DNS 미게시) 붙을 대상이 없으므로 프로세스를 띄우지 않는다.
   * 켜져 있는데 아직 안 붙었으면 새로 띄우거나, 이미 재시도 중이면 재시작해
   * 백오프를 초기화한다 — openvpn 은 실패할수록 간격을 최대 5분까지 벌리므로
   * 방금 켠 VPN 에 바로 붙으려면 되돌려야 한다.
   */
  async recheck(): Promise<VpnStatus> {
    const status = await this.status();
    if (status.endpointResolvable !== true || status.tunnel === 'up') {
      return status;
    }

    this.logger.log('VPN 이 켜져 있습니다. 터널 접속을 시도합니다.');
    this.tunnel?.restart();
    return { ...status, tunnel: 'starting' };
  }

  /**
   * Client VPN 은 서브넷이 연결돼 있을 때만 엔드포인트 이름을 DNS 에 게시한다.
   * 해석 여부만으로 "개발자가 VPN 을 켜 두었는가" 를 자격증명 없이 알 수 있다.
   */
  private async probeEndpointDns(): Promise<boolean | null> {
    if (this.endpointHost === null) return null;
    try {
      await dns.resolve4(this.endpointHost);
      return true;
    } catch {
      return false;
    }
  }

  /** DB 에 TCP 로 닿는지 — db-read.sh 의 도달 확인과 같은 판정. */
  private async probeTarget(): Promise<boolean | null> {
    const target = this.resolveProbeTarget();
    if (!target) return null;

    return new Promise((resolve) => {
      const socket = connect(target.port, target.host);
      const finish = (reachable: boolean): void => {
        socket.destroy();
        resolve(reachable);
      };
      socket.setTimeout(PROBE_TIMEOUT_MS);
      socket.on('connect', () => finish(true));
      socket.on('error', () => finish(false));
      socket.on('timeout', () => finish(false));
    });
  }

  private resolveProbeTarget(): { host: string; port: number } | null {
    const explicit = this.config.vpn.probeTarget;
    if (explicit) {
      const [host, port] = explicit.split(':');
      if (host) return { host, port: Number(port) || DEFAULT_PG_PORT };
    }

    const url = process.env.DATABASE_URL;
    if (!url) return null;
    try {
      const parsed = new URL(url);
      return { host: parsed.hostname, port: Number(parsed.port) || DEFAULT_PG_PORT };
    } catch {
      return null;
    }
  }
}
