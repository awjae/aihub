import { useCallback, useEffect, useState } from 'react';

import { fetchVpnStatus, recheckVpn } from './api';
import type { VpnStatus } from './types';

const POLL_INTERVAL_MS = 15_000;

interface Options {
  /** VPN 이 필요 없는 앱에서는 아예 조회하지 않는다. */
  enabled: boolean;
  /** 연결·해제가 SSE 로 진행 상황을 주는 동안에는 폴링을 쉰다. */
  paused: boolean;
}

/**
 * VPN 상태를 주기적으로 읽는다. VPN 패널과 실행 잠금이 같은 값을 봐야
 * "연결됨인데 버튼은 잠김" 같은 어긋남이 생기지 않으므로, 이 훅은 그 앱에서
 * **한 번만** 쓰고 결과를 아래로 내려준다.
 */
export function useVpnStatus({ enabled, paused }: Options) {
  const [status, setStatus] = useState<VpnStatus | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      setStatus(await fetchVpnStatus(signal));
    } catch {
      // 폴링 실패는 조용히 넘어간다 — 다음 주기에 다시 시도한다.
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();
    // 앱을 여는 것 자체가 접속 계기다 — 첫 호출만 recheck 로 보내 터널을 세운다.
    void recheckVpn()
      .then((next) => {
        if (!controller.signal.aborted) setStatus(next);
      })
      .catch(() => undefined);

    const timer = setInterval(() => {
      if (!paused) void refresh(controller.signal);
    }, POLL_INTERVAL_MS);

    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refresh, enabled, paused]);

  return { status, setStatus };
}

/**
 * 실행을 허용할지. 최종 판단은 **DB 에 실제로 닿는지** 하나다 —
 * 터널이 서 있어도 라우팅이 안 잡히면 조회는 실패하기 때문이다.
 */
export function canReachPrivateNetwork(status: VpnStatus | null): boolean {
  return status?.dbReachable === true;
}

/** 왜 못 쓰는지 한 줄로. 상태를 확정 못 한 경우와 꺼진 경우를 구분한다. */
export function describeBlockedReason(status: VpnStatus | null): string {
  if (status === null) return 'VPN 상태를 확인하는 중입니다…';
  if (!status.configured) {
    return 'VPN 제어가 설정되지 않았습니다. 서버의 VPN_OVPN_CONFIG 를 확인하세요.';
  }
  if (status.dbReachable === null) return 'DB 주소가 설정되지 않았습니다.';
  if (status.endpointResolvable === false) {
    return 'VPN 이 꺼져 있어 조회할 수 없습니다. 개발자에게 연결을 요청하세요.';
  }
  if (status.tunnel !== 'up') {
    return 'VPN 에 접속하는 중입니다. 잠시 후 다시 시도하세요.';
  }
  return '터널은 섰지만 DB 에 닿지 않습니다. 잠시 후 다시 시도하세요.';
}
