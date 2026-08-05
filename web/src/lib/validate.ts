import type { AppSummary, FieldDefinition } from './types';

/** 앞뒤 공백을 제외한 실제 입력 길이. 서버의 trim 규칙과 동일하게 맞춘다. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value);
}

function isTextField(field: FieldDefinition): boolean {
  return field.type === 'text' || field.type === 'textarea';
}

/**
 * 제출 전 클라이언트 측 검증.
 * 서버가 최종 판정을 하지만, 여기서 먼저 걸러 왕복 한 번을 아낀다.
 * 반환값이 null 이면 통과.
 */
export function validate(app: AppSummary, values: Record<string, unknown>): string | null {
  const filled = new Set<string>();

  for (const field of app.fields) {
    const text = textOf(values[field.key]);

    if (text === '') {
      if (field.required) return `'${field.label}' 항목은 필수입니다.`;
      continue;
    }
    filled.add(field.key);

    if (!isTextField(field)) continue;

    if (field.minLength !== undefined && text.length < field.minLength) {
      return `'${field.label}' 은(는) 최소 ${field.minLength}자 이상 입력해야 합니다.`;
    }
    if (field.maxLength !== undefined && text.length > field.maxLength) {
      return `'${field.label}' 은(는) 최대 ${field.maxLength}자까지 입력할 수 있습니다.`;
    }
  }

  if (app.requireOneOf.length > 0 && !app.requireOneOf.some((key) => filled.has(key))) {
    const labels = app.requireOneOf.map(
      (key) => app.fields.find((field) => field.key === key)?.label ?? key,
    );
    return `${labels.join(', ')} 중 최소 하나는 입력해야 합니다.`;
  }

  return null;
}

/** 입력 칸 아래에 띄울 글자 수 안내. 최소 길이가 있을 때만 표시. */
export function lengthHint(field: FieldDefinition, value: unknown): string | null {
  if (!isTextField(field) || field.minLength === undefined) return null;

  const length = textOf(value).length;
  if (length === 0) return `최소 ${field.minLength}자`;
  if (length < field.minLength) return `${length} / ${field.minLength}자 — ${field.minLength - length}자 더 필요합니다`;
  return `${length}자`;
}
