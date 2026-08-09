import { lengthHint } from '../lib/validate';
import type { AppSummary, FieldDefinition } from '../lib/types';

interface Props {
  app: AppSummary;
  values: Record<string, unknown>;
  disabled: boolean;
  /** 클라이언트 검증 실패 사유. null 이면 제출 가능. */
  blockedReason: string | null;
  onChange: (key: string, value: unknown) => void;
  onSubmit: () => void;
}

/** apps.yaml 의 fields 정의를 그대로 입력 폼으로 렌더링한다. */
export default function DynamicForm({
  app,
  values,
  disabled,
  blockedReason,
  onChange,
  onSubmit,
}: Props) {
  const oneOfLabels = app.requireOneOf.map(
    (key) => app.fields.find((field) => field.key === key)?.label ?? key,
  );

  return (
    <form
      className="form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {oneOfLabels.length > 0 && (
        <p className="form-notice">
          <strong>{oneOfLabels.join(' · ')}</strong> 중 최소 하나는 입력해야 합니다.
        </p>
      )}

      {app.fields.map((field) => {
        const hint = lengthHint(field, values[field.key]);
        return (
          <div className="field" key={field.key}>
            <label className="field-label" htmlFor={`field-${field.key}`}>
              {field.label}
              {field.required && <span className="required">필수</span>}
              {!field.required && app.requireOneOf.includes(field.key) && (
                <span className="optional">선택</span>
              )}
            </label>

            {renderInput(field, values[field.key], disabled, onChange)}

            <div className="field-foot">
              {field.help && <p className="field-help">{field.help}</p>}
              {hint && <p className="field-count">{hint}</p>}
            </div>
          </div>
        );
      })}

      <button className="btn-primary" type="submit" disabled={disabled || blockedReason !== null}>
        {disabled ? '실행 중…' : '실행'}
      </button>
    </form>
  );
}

function renderInput(
  field: FieldDefinition,
  value: unknown,
  disabled: boolean,
  onChange: (key: string, value: unknown) => void,
) {
  const id = `field-${field.key}`;
  const common = { id, disabled, className: 'input' as const };

  switch (field.type) {
    case 'textarea':
      return (
        <textarea
          {...common}
          rows={field.rows ?? 8}
          placeholder={field.placeholder}
          value={String(value ?? '')}
          onChange={(event) => onChange(field.key, event.target.value)}
        />
      );

    case 'select':
      return (
        <select
          {...common}
          value={String(value ?? '')}
          onChange={(event) => onChange(field.key, event.target.value)}
        >
          <option value="">선택하세요</option>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );

    case 'number':
      return (
        <input
          {...common}
          type="number"
          min={field.min}
          max={field.max}
          placeholder={field.placeholder}
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(event) => onChange(field.key, event.target.value)}
        />
      );

    case 'checkbox':
      return (
        <label className="checkbox">
          <input
            id={id}
            type="checkbox"
            disabled={disabled}
            checked={value === true}
            onChange={(event) => onChange(field.key, event.target.checked)}
          />
          <span>{field.placeholder ?? '예'}</span>
        </label>
      );

    default:
      return (
        <input
          {...common}
          type="text"
          placeholder={field.placeholder}
          value={String(value ?? '')}
          onChange={(event) => onChange(field.key, event.target.value)}
        />
      );
  }
}
