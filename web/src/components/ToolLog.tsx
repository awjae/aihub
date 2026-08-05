import { useState } from 'react';

import type { ToolLogEntry } from '../lib/types';

interface Props {
  entries: ToolLogEntry[];
}

/** 게이트웨이가 실행한 MCP 툴 내역. 기본은 접힌 상태 — 비개발직군에게는 노이즈이므로. */
export default function ToolLog({ entries }: Props) {
  const [open, setOpen] = useState(false);

  if (entries.length === 0) return null;

  const running = entries.filter((entry) => entry.status === 'running').length;
  const failed = entries.filter((entry) => entry.status === 'error').length;

  return (
    <div className="tool-log">
      <button className="tool-log-toggle" type="button" onClick={() => setOpen((prev) => !prev)}>
        <span className={`chevron ${open ? 'open' : ''}`}>›</span>
        도구 실행 {entries.length}건
        {running > 0 && <span className="badge badge-running">진행 중 {running}</span>}
        {failed > 0 && <span className="badge badge-error">실패 {failed}</span>}
      </button>

      {open && (
        <ol className="tool-log-list">
          {entries.map((entry) => (
            <li key={entry.id} className={`tool-log-item status-${entry.status}`}>
              <div className="tool-log-head">
                <code>{entry.name}</code>
                <span className="tool-log-meta">
                  {entry.status === 'running' && '실행 중…'}
                  {entry.status === 'ok' && `완료 · ${entry.ms}ms`}
                  {entry.status === 'error' && `실패 · ${entry.ms}ms`}
                </span>
              </div>
              <pre className="tool-log-body">{JSON.stringify(entry.input, null, 2)}</pre>
              {entry.preview && <pre className="tool-log-body result">{entry.preview}</pre>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
