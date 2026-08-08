import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import DynamicForm from './DynamicForm';
import { VpnPanel } from './VpnPanel';
import ResponsePanel from './ResponsePanel';
import { runApp } from '../lib/api';
import { formatRecords, parseRecords } from '../lib/parseRecords';
import { validate } from '../lib/validate';
import { canReachPrivateNetwork, describeBlockedReason, useVpnStatus } from '../lib/useVpnStatus';
import type { AppSummary, ToolLogEntry } from '../lib/types';

interface Props {
  app: AppSummary;
}

type Status = 'idle' | 'running' | 'done' | 'error';

function initialValues(app: AppSummary): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of app.fields) {
    if (field.default !== undefined) values[field.key] = field.default;
    else if (field.type === 'checkbox') values[field.key] = false;
  }
  return values;
}

export default function AppRunner({ app }: Props) {
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues(app));
  const [status, setStatus] = useState<Status>('idle');
  const [text, setText] = useState('');
  const [reasoning, setReasoning] = useState('');
  const [tools, setTools] = useState<ToolLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  // 서버가 최종 판정을 하지만, 여기서 먼저 막아 왕복 한 번을 아낀다.
  const inputError = useMemo(() => validate(app, values), [app, values]);

  // VPC 내부 자원을 쓰는 앱은 실제로 닿을 때만 실행을 허용한다. 막아두지 않으면
  // 사용자가 제출하고 수십 초 기다린 끝에 커넥션 실패만 보게 된다.
  //
  // 상태를 여기서 한 번만 읽어 VPN 패널과 실행 잠금이 같은 값을 본다.
  const { status: vpnStatus, setStatus: setVpnStatus } = useVpnStatus({
    enabled: app.requiresVpn,
    paused: status === 'running',
  });
  const vpnBlocked = app.requiresVpn && !canReachPrivateNetwork(vpnStatus);
  const blockedReason = inputError ?? (vpnBlocked ? describeBlockedReason(vpnStatus) : null);

  // 앱이 records 포맷일 때만 파싱한다. 파싱 실패 시 null → 원문 그대로 표시.
  const recordsFormat = app.responseFormat.type === 'records' ? app.responseFormat : null;
  const records = useMemo(
    () => (recordsFormat && text ? parseRecords(text, recordsFormat) : null),
    [recordsFormat, text],
  );

  // 앱을 바꾸면 폼과 결과를 초기화하고 진행 중이던 요청은 끊는다.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setValues(initialValues(app));
    setStatus('idle');
    setText('');
    setReasoning('');
    setTools([]);
    setError(null);
  }, [app]);

  // 언마운트 시 진행 중인 스트림 정리.
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleChange = useCallback((key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (blockedReason !== null) {
      setError(blockedReason);
      setStatus('error');
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus('running');
    setText('');
    setReasoning('');
    setTools([]);
    setError(null);
    setCopied(false);

    try {
      for await (const event of runApp(app.id, values, controller.signal)) {
        switch (event.type) {
          case 'text':
            setText((prev) => prev + event.text);
            break;

          case 'reasoning':
            setReasoning((prev) => prev + event.text);
            break;

          case 'tool_call':
            setTools((prev) => [
              ...prev,
              { id: event.id, name: event.name, input: event.input, status: 'running' },
            ]);
            break;

          case 'tool_result':
            setTools((prev) =>
              prev.map((entry) =>
                entry.id === event.id
                  ? {
                      ...entry,
                      status: event.ok ? 'ok' : 'error',
                      preview: event.preview,
                      ms: event.ms,
                    }
                  : entry,
              ),
            );
            break;

          case 'error':
            setError(event.message);
            setStatus('error');
            return;

          case 'done':
            setStatus('done');
            return;

          case 'start':
            break;
        }
      }
      // 서버가 done 없이 스트림을 닫은 경우 (프록시 타임아웃 등).
      setStatus((prev) => (prev === 'running' ? 'done' : prev));
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus('error');
    }
  }, [app.id, blockedReason, values]);

  const handleCopy = useCallback(() => {
    // 카드로 보이고 있으면 화면에 보이는 형태 그대로 복사한다.
    const payload = records && recordsFormat ? formatRecords(records, recordsFormat) : text;
    void navigator.clipboard.writeText(payload).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [records, recordsFormat, text]);

  // ⌘/Ctrl + Enter 로 실행.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && status !== 'running') {
        event.preventDefault();
        void handleSubmit();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSubmit, status]);

  return (
    <div className="runner">
      <section className="panel">
        <header className="panel-head">
          <h1>
            {app.icon && <span className="app-icon">{app.icon}</span>}
            {app.name}
          </h1>
          {app.description && <p className="panel-desc">{app.description}</p>}
          {app.hasTools && <span className="tag">사내 도구 연동</span>}
        </header>

        {app.requiresVpn && <VpnPanel status={vpnStatus} onStatus={setVpnStatus} />}

        <DynamicForm
          app={app}
          values={values}
          disabled={status === 'running'}
          blockedReason={blockedReason}
          onChange={handleChange}
          onSubmit={() => void handleSubmit()}
        />

        {status === 'running' && (
          <button
            className="btn-ghost btn-stop"
            type="button"
            onClick={() => {
              abortRef.current?.abort();
              setStatus('idle');
            }}
          >
            중단
          </button>
        )}
      </section>

      <ResponsePanel
        text={text}
        records={records}
        recordsFormat={recordsFormat}
        reasoning={reasoning}
        tools={tools}
        status={status}
        error={error}
        onCopy={handleCopy}
        copied={copied}
      />
    </div>
  );
}
