import type { RecordsFormat } from './types';

/** 파싱된 레코드 한 건: 키 → 값 */
export type ParsedRecord = Record<string, string>;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 문자열의 각 글자를 "여기까지만 와도 매치" 형태의 중첩 옵션으로 만든다.
 * `]:` → `(?:\](?::)?)?`
 *
 * 스트리밍 중 마커가 `[na`, `[name`, `[name]` 처럼 잘려 들어올 때
 * 그 조각이 화면에 노출되지 않도록 잘라내기 위해 쓴다.
 */
function optionalTail(text: string): string {
  if (text === '') return '';
  return `(?:${escapeRegex(text[0])}${optionalTail(text.slice(1))})?`;
}

interface Matchers {
  marker: RegExp;
  /**
   * 잘린 마커 조각 매처. 마커에 앞쪽 리터럴(`[` 등)이 없으면 null —
   * 그 경우 조각을 실제 값과 구분할 방법이 없어 지우려 들면 멀쩡한 값을 깎아먹는다.
   */
  partial: RegExp | null;
}

/** `[{key}]:` 같은 마커 정의를 정규식으로 컴파일한다. */
function compile(markerTemplate: string): Matchers {
  const slot = markerTemplate.indexOf('{key}');
  const prefix = markerTemplate.slice(0, slot);
  const suffix = markerTemplate.slice(slot + '{key}'.length);

  return {
    marker: new RegExp(`${escapeRegex(prefix)}([a-zA-Z0-9_]+)${escapeRegex(suffix)}\\s*`, 'g'),
    partial:
      prefix === ''
        ? null
        : new RegExp(`${escapeRegex(prefix)}[a-zA-Z0-9_]*${optionalTail(suffix)}\\s*$`),
  };
}

/**
 * 모델 출력을 반복 레코드로 파싱한다.
 * 이미 값이 채워진 키가 다시 나오면 새 레코드가 시작된 것으로 본다 —
 * 줄바꿈으로 나뉘든 한 줄에 이어 붙든 동일하게 동작한다.
 *
 * 형식을 못 찾으면 null. 호출부는 이때 원문을 그대로 보여줘야 한다.
 */
export function parseRecords(raw: string, format: RecordsFormat): ParsedRecord[] | null {
  const { marker, partial } = compile(format.marker);
  const markers = [...raw.matchAll(marker)];
  if (markers.length === 0) return null;

  const records: ParsedRecord[] = [];
  let current: ParsedRecord = {};

  markers.forEach((match, index) => {
    const key = match[1];
    const isLast = index === markers.length - 1;
    const start = (match.index ?? 0) + match[0].length;
    const end = isLast ? raw.length : (markers[index + 1].index ?? raw.length);

    // 잘린 마커는 마지막 값 끝에서만 생길 수 있다. 앞선 값들은 건드리지 않는다.
    const slice = raw.slice(start, end);
    const value = (isLast && partial ? slice.replace(partial, '') : slice).trim();

    if (current[key] !== undefined) {
      records.push(current);
      current = {};
    }
    current[key] = value;
  });

  if (Object.keys(current).length > 0) records.push(current);

  // 값이 전부 빈 껍데기는 버린다 (스트리밍 첫 프레임 등).
  const meaningful = records.filter((record) => Object.values(record).some((v) => v !== ''));
  return meaningful.length > 0 ? meaningful : null;
}

/**
 * `{name_ko} ({name})` 같은 행 템플릿에 값을 채운다.
 *
 * 참조한 키가 전부 비어 있으면 null 을 반환해 행 자체를 숨기고,
 * 일부만 비면 치환 후 남는 빈 괄호·중복 공백을 정리한다.
 */
export function renderRow(template: string, record: ParsedRecord): string | null {
  const keys = [...template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]);
  if (keys.every((key) => !record[key])) return null;

  const filled = template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => record[key] ?? '');

  const cleaned = filled
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, '') // 값이 비어 껍데기만 남은 괄호 제거
    .replace(/\s{2,}/g, ' ')
    .trim()
    // 앞쪽 값이 비어 전체가 괄호로 감싸진 꼴( "(Otitis Externa)" )이 되면 괄호를 벗긴다.
    // 스트리밍 도중 뒤쪽 키가 먼저 도착했을 때 주로 발생한다.
    .replace(/^\(([^()]*)\)$/, '$1')
    .trim();

  return cleaned === '' ? null : cleaned;
}

/** 복사 버튼용 — 화면에 보이는 형태 그대로 텍스트화. */
export function formatRecords(records: ParsedRecord[], format: RecordsFormat): string {
  return records
    .map((record, index) => {
      const lines = [`${format.itemLabel} ${index + 1}`];
      for (const row of format.rows) {
        const value = renderRow(row.value, record);
        if (value !== null) lines.push(`${row.label}: ${value}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}
