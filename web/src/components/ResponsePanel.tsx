import { useEffect, useRef } from 'react';

import { DataResult } from './DataResult';
import RecordList from './RecordList';
import type { ParsedRecord } from '../lib/parseRecords';
import type { DirectQueryResult, RecordsFormat, StepEntry } from '../lib/types';

interface Props {
  /** direct 모드 결과. 있으면 문장 대신 이걸 그린다. */
  data: DirectQueryResult | null;
  text: string;
  /** responseFormat 파싱 결과. null 이면 원문(text)을 그대로 보여준다. */
  records: ParsedRecord[] | null;
  recordsFormat: RecordsFormat | null;
  steps: StepEntry[];
  status: 'idle' | 'running' | 'done' | 'error';
  error: string | null;
  onCopy: () => void;
  copied: boolean;
}

export default function ResponsePanel({
  data,
  text,
  records,
  recordsFormat,
  steps,
  status,
  error,
  onCopy,
  copied,
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  // 스트리밍 중에는 아래로 따라가되, 사용자가 위로 스크롤하면 방해하지 않는다.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [text, data]);

  const empty = status === 'idle' && !text && !data && steps.length === 0;

  return (
    <section className="response">
      <header className="response-head">
        <h2>응답</h2>
        <div className="response-actions">
          {status === 'running' && <span className="status status-running">생성 중…</span>}
          {status === 'done' && <span className="status status-done">완료</span>}
          {text && (
            <button className="btn-ghost" type="button" onClick={onCopy}>
              {copied ? '복사됨' : '복사'}
            </button>
          )}
        </div>
      </header>

      <div
        className="response-body"
        ref={bodyRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {empty && <p className="placeholder">왼쪽 폼을 채우고 실행하면 여기에 결과가 표시됩니다.</p>}

        {/* 조회는 여러 초 걸린다. 어디까지 왔는지 보여줘야 멈춘 게 아님을 안다. */}
        {steps.length > 0 && !data && (
          <ol className="steps">
            {steps.map((step) => (
              <li key={step.name}>{step.message}</li>
            ))}
          </ol>
        )}

        {data ? (
          <DataResult result={data} />
        ) : records && recordsFormat ? (
          <RecordList records={records} format={recordsFormat} streaming={status === 'running'} />
        ) : (
          text && <div className="response-text">{text}</div>
        )}

        {status === 'running' && text && !records && <span className="cursor" aria-hidden="true" />}

        {error && (
          <div className="error-box" role="alert">
            <strong>오류</strong>
            <p>{error}</p>
          </div>
        )}
      </div>
    </section>
  );
}
