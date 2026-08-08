import type { DirectQueryResult } from '../lib/types';

/**
 * direct 모드 결과 화면.
 *
 * 문장을 만들지 않습니다. 조회 결과는 모델을 거치지 않고 여기까지 오므로,
 * 숫자를 지어낼 여지가 없다는 것이 이 화면의 요점입니다. 그래서 값을 그대로
 * 보여주고 근거 SQL 을 항상 함께 답니다.
 */
export function DataResult({ result }: { result: DirectQueryResult }) {
  if (!result.executed) {
    return (
      <div className="data-result">
        <p className="data-note">
          조회하지 않았습니다. SQL 만 생성했습니다{result.reason ? ` — ${result.reason}` : '.'}
        </p>
        <SqlBlock sql={result.sql} parameters={result.parameters} />
      </div>
    );
  }

  const { rows, columns, rowCount, truncated } = result;
  const single = rows.length === 1 && columns.length === 1;

  return (
    <div className="data-result">
      {single ? (
        // 집계 한 칸이면 표가 아니라 숫자로 보여준다 — 대부분의 질문이 이 형태다.
        <div className="data-single">
          <span className="data-single-label">{columns[0]}</span>
          <strong className="data-single-value">{formatCell(rows[0][columns[0]])}</strong>
        </div>
      ) : rows.length === 0 ? (
        <p className="data-note">조건에 맞는 행이 없습니다 (0건).</p>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {columns.map((column) => (
                    <td key={column}>{formatCell(row[column])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="data-meta">
        {rowCount}건 조회{rows.length !== rowCount && `, ${rows.length}건 표시`}
        {truncated && ' — 잘렸습니다. 합계·건수로 다시 물어보세요.'}
      </p>

      <SqlBlock sql={result.sql} parameters={result.parameters} />
    </div>
  );
}

function SqlBlock({ sql, parameters }: { sql: string; parameters: unknown[] }) {
  return (
    <details className="data-sql">
      <summary>실행된 SQL</summary>
      <pre>{sql}</pre>
      <pre className="data-sql-params">파라미터: {JSON.stringify(parameters)}</pre>
    </details>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  // 금액·건수를 눈으로 읽을 수 있게. 소수는 그대로 둔다.
  if (typeof value === 'number') return value.toLocaleString('ko-KR');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
