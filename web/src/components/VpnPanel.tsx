import { useState } from 'react';

import { recheckVpn } from '../lib/api';
import type { VpnStatus } from '../lib/types';

interface Props {
  status: VpnStatus | null;
  onStatus: (status: VpnStatus) => void;
}

/**
 * 운영 DB 연결 상태 표시.
 *
 * Client VPN 은 접속이 없어도 연결 시간만큼 과금돼서 **개발자가 필요할 때만**
 * 켭니다. 사용자가 켜고 끌 버튼을 두면 그 통제가 사라지므로, 여기서 할 수 있는
 * 것은 "다시 확인" 뿐입니다 — 상태를 새로 재고, VPN 이 켜졌으면 서버가 즉시
 * 다시 붙어 봅니다 (openvpn 의 재시도 간격이 최대 5분까지 벌어지기 때문).
 */
export function VpnPanel({ status, onStatus }: Props) {
  const [checking, setChecking] = useState(false);

  // VPC 안에 배포한 경우엔 이 기능 자체가 불필요하다.
  if (status !== null && !status.configured) return null;

  const recheck = async () => {
    setChecking(true);
    try {
      onStatus(await recheckVpn());
    } catch {
      // 실패해도 표시는 유지한다 — 다음 폴링이 갱신한다.
    } finally {
      setChecking(false);
    }
  };

  if (status?.dbReachable === true) {
    return (
      <div className="vpn-panel connected">
        <span className="vpn-dot on" aria-hidden />
        <span className="vpn-connected-label">운영 DB 에 연결됨</span>
      </div>
    );
  }

  const connecting = checking || status?.endpointResolvable === true;

  return (
    <div className="vpn-panel">
      <div className="vpn-head">
        <span className={`vpn-dot ${connecting ? 'busy' : 'off'}`} aria-hidden />
        <div className="vpn-head-body">
          <strong>운영 DB 에 연결되어 있지 않습니다</strong>
          <small>{checking ? '다시 확인하는 중…' : describe(status)}</small>
        </div>
        <button
          type="button"
          className="vpn-recheck"
          onClick={() => void recheck()}
          disabled={checking}
        >
          다시 확인
        </button>
      </div>
    </div>
  );
}

function describe(status: VpnStatus | null): string {
  if (status === null) return '상태를 확인하는 중…';
  if (status.dbReachable === null) return 'DB 주소가 설정되지 않았습니다.';

  // VPN 이 켜져 있으면 서버가 알아서 붙는 중이다 — 기다리거나 다시 확인하면 된다.
  if (status.endpointResolvable === true) {
    return status.tunnel === 'up'
      ? '터널은 섰지만 DB 에 아직 닿지 않습니다.'
      : 'VPN 이 켜져 있습니다. 서버가 접속하는 중입니다.';
  }

  return 'VPN 이 꺼져 있습니다. 개발자에게 연결을 요청한 뒤 다시 확인하세요.';
}
