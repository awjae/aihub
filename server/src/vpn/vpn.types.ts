/** 컨테이너 안 openvpn 터널 상태. */
export type TunnelState = 'down' | 'starting' | 'up';

export interface VpnStatus {
  /** .ovpn 이 갖춰져 기능이 켜져 있는지. 꺼져 있으면 UI 도 그리지 않는다. */
  configured: boolean;
  /**
   * 엔드포인트 DNS 가 해석되는지 = 개발자가 서브넷을 켜 두었는지.
   * AWS 자격증명 없이 알 수 있는 유일한 신호다.
   */
  endpointResolvable: boolean | null;
  tunnel: TunnelState;
  /** 실제로 DB 에 닿는지 — 사용자가 최종적으로 알고 싶은 것. */
  dbReachable: boolean | null;
}
