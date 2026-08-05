import { renderRow, type ParsedRecord } from '../lib/parseRecords';
import type { RecordsFormat } from '../lib/types';

interface Props {
  records: ParsedRecord[];
  format: RecordsFormat;
  /** 스트리밍 중이면 마지막 레코드는 아직 채워지는 중일 수 있다. */
  streaming: boolean;
}

/** 파싱된 레코드를 카드 목록으로 표시한다. 어떤 항목을 어떤 라벨로 보여줄지는 앱 설정이 정한다. */
export default function RecordList({ records, format, streaming }: Props) {
  return (
    <ol className="rec-list">
      {records.map((record, index) => {
        const pending = streaming && index === records.length - 1;
        const rows = format.rows
          .map((row) => ({ label: row.label, style: row.style, value: renderRow(row.value, record) }))
          .filter((row) => row.value !== null);

        return (
          <li className={`rec-card ${pending ? 'pending' : ''}`} key={index}>
            <p className="rec-rank">
              {format.itemLabel} {index + 1}
            </p>

            <dl className="rec-rows">
              {rows.map((row) => (
                <div className="rec-row" key={row.label}>
                  <dt>{row.label}</dt>
                  <dd className={row.style === 'code' ? 'rec-mono' : 'rec-value'}>{row.value}</dd>
                </div>
              ))}
            </dl>
          </li>
        );
      })}
    </ol>
  );
}
