import type { AppSummary, StreamEvent, VpnStatus } from './types';

export async function fetchApps(): Promise<AppSummary[]> {
  const response = await fetch('/api/apps');
  if (!response.ok) throw new Error(`앱 목록을 불러오지 못했습니다 (HTTP ${response.status})`);
  const body = (await response.json()) as { apps: AppSummary[] };
  return body.apps;
}

/**
 * 앱을 실행하고 SSE 스트림을 이벤트 단위로 흘려준다.
 *
 * EventSource 는 POST 를 못 보내므로 fetch + ReadableStream 으로 직접 파싱한다.
 */
export function runApp(
  appId: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  return streamSse<StreamEvent>(`/api/run/${encodeURIComponent(appId)}`, { input }, signal);
}

export async function fetchVpnStatus(signal?: AbortSignal): Promise<VpnStatus> {
  const response = await fetch('/api/vpn/status', signal ? { signal } : undefined);
  if (!response.ok) throw new Error(`VPN 상태를 불러오지 못했습니다 (HTTP ${response.status})`);
  return (await response.json()) as VpnStatus;
}

/**
 * 상태를 다시 재고, VPN 이 켜졌는데 아직 안 붙었으면 터널 재시도를 앞당긴다.
 * openvpn 의 백오프가 최대 5분까지 벌어지므로 사용자가 기다리지 않게 하는 장치다.
 */
export async function recheckVpn(): Promise<VpnStatus> {
  const response = await fetch('/api/vpn/recheck', { method: 'POST' });
  if (!response.ok) throw new Error(`다시 확인하지 못했습니다 (HTTP ${response.status})`);
  return (await response.json()) as VpnStatus;
}

/** POST 로 여는 SSE 를 이벤트 단위로 흘려준다. EventSource 는 POST 를 못 보낸다. */
async function* streamSse<T>(
  url: string,
  body: unknown,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(parseErrorMessage(detail) ?? `요청이 실패했습니다 (HTTP ${response.status})`);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += value;

      // SSE 는 빈 줄로 프레임이 나뉜다.
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        const payload = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');

        // ': keep-alive' 같은 주석 프레임은 data 가 없다.
        if (!payload) continue;

        try {
          yield JSON.parse(payload) as T;
        } catch {
          // 프레임이 깨진 경우는 조용히 무시하고 다음 프레임으로 넘어간다.
        }
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/** Nest 의 에러 응답({ message }) 에서 사람이 읽을 메시지를 뽑는다. */
function parseErrorMessage(raw: string): string | null {
  if (!raw) return null;
  try {
    const body = JSON.parse(raw) as { message?: string | string[] };
    if (Array.isArray(body.message)) return body.message.join(', ');
    return body.message ?? null;
  } catch {
    return null;
  }
}
