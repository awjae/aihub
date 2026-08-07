import { z } from 'zod';

/**
 * 설정 파일의 단일 진실 출처.
 *
 * 여기 정의한 zod 스키마로 (1) 런타임 검증을 하고
 * (2) 에디터용 config/apps.schema.json 을 생성한다 (npm run schema).
 * 두 곳을 따로 관리하지 않으므로 어긋날 수 없다.
 */

/** 문자열 또는 줄 배열. JSON 에는 블록 스칼라가 없어 배열 표기를 허용한다. */
const multiline = z
  .union([z.string().min(1), z.array(z.string()).min(1)])
  .describe('문자열, 또는 줄 단위 문자열 배열(줄바꿈으로 이어집니다).')
  .transform((value) => (Array.isArray(value) ? value.join('\n') : value));

const responseRow = z
  .strictObject({
    label: z.string().min(1).describe('카드에 표시할 항목명 (예: 진단명)'),
    value: z
      .string()
      .regex(/\{[a-zA-Z0-9_]+\}/, "'{key}' 형태의 참조를 최소 하나 포함해야 합니다.")
      .describe('{key} 에 파싱된 값이 치환됩니다. 예: {name_ko} ({name})'),
    style: z.enum(['text', 'code']).optional().describe('code 면 등폭 폰트로 표시'),
  })
  .describe('레코드 카드의 한 행');

const responseFormat = z
  .union([
    z.strictObject({ type: z.literal('text') }),
    z.strictObject({
      type: z.literal('records'),
      itemLabel: z
        .string()
        .min(1)
        .describe('카드 제목. "추천 진단" → "추천 진단 1", "추천 진단 2"'),
      marker: z
        .string()
        .refine(
          (value) => value.split('{key}').length === 2,
          "'{key}' 를 정확히 한 번 포함해야 합니다. (예: '[{key}]:')",
        )
        .describe('값 앞에 오는 마커. {key} 자리에 키 이름이 들어갑니다.'),
      rows: z.array(responseRow).min(1),
    }),
  ])
  .describe('응답 영역 표시 방식. 모델의 출력 포맷에 맞춰 정의합니다.');

/**
 * 모델 = "어떻게 말을 걸고 어떻게 답을 읽는가".
 * fine-tuned 모델은 이 규약이 학습 데이터로 정해져 있으므로 앱이 아니라 모델이 소유한다.
 */
export const modelSchema = z
  .strictObject({
    provider: z
      .enum(['openai'])
      .describe('사내 vLLM 등 OpenAI 호환 엔드포인트도 포함합니다 (baseURL 로 지정).'),
    model: z.string().min(1).describe('모델 ID.'),
    baseURL: z
      .string()
      .url()
      .optional()
      .describe('이 모델만 다른 엔드포인트를 쓸 때. 생략하면 프로바이더 기본값.'),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z0-9_]+$/)
      .optional()
      .describe('이 모델에 쓸 API 키가 담긴 환경변수 이름. 값이 아니라 "이름"입니다.'),

    maxTokens: z.int().min(1).default(4096),

    systemPrompt: multiline.optional().describe('학습 데이터의 system 메시지와 일치시키세요.'),
    userTemplate: multiline.describe(
      'user 메시지 템플릿. {{key}} 에 폼 입력값이 치환되고, 값이 전부 빈 줄은 제거됩니다.',
    ),
    responseFormat: responseFormat.optional().default({ type: 'text' }),
  })
  .describe('모델 연결 + 프롬프트/응답 규약');

const FIELD_TYPES = ['text', 'textarea', 'select', 'number', 'checkbox'] as const;

const fieldSchema = z
  .strictObject({
    key: z
      .string()
      .regex(/^[a-zA-Z0-9_]+$/, '영문·숫자·언더스코어만 사용할 수 있습니다.')
      .describe('모델 userTemplate 의 {{key}} 와 대응합니다.'),
    label: z.string().min(1).describe('입력 칸 위에 표시될 항목명'),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().optional().describe('비어 있으면 실행 거부'),
    placeholder: z.string().optional(),
    help: z.string().optional().describe('입력 칸 아래 설명'),
    rows: z.int().min(1).optional().describe('textarea 높이(줄 수)'),
    options: z.array(z.string()).min(1).optional().describe('select 타입의 선택지'),
    default: z
      .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
      .optional()
      .describe('폼 초기값. 여러 줄이면 문자열 배열로. (defaultValue 아님)'),
    min: z.number().optional().describe('number 전용'),
    max: z.number().optional().describe('number 전용'),
    minLength: z.int().min(0).optional().describe('text·textarea. 앞뒤 공백 제외 길이 기준.'),
    maxLength: z.int().min(0).optional().describe('text·textarea. 앞뒤 공백 제외 길이 기준.'),
  })
  .refine((field) => field.type !== 'select' || (field.options?.length ?? 0) > 0, {
    error: 'select 타입은 options 배열이 필요합니다.',
    path: ['options'],
  })
  .refine(
    (field) =>
      field.minLength === undefined ||
      field.maxLength === undefined ||
      field.minLength <= field.maxLength,
    { error: 'minLength 가 maxLength 보다 클 수 없습니다.', path: ['minLength'] },
  );

/** 앱 = "사용자에게 어떻게 보이는가". 모델은 이름으로 참조한다. */
export const appSchema = z
  .strictObject({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, '소문자·숫자·하이픈만 사용할 수 있습니다.')
      .describe('식별자. URL 해시(#my-app)로 직접 진입할 수 있습니다.'),
    name: z.string().min(1).describe('화면에 표시될 앱 이름'),
    description: z.string().optional().describe('사이드바에 표시될 한 줄 설명'),
    icon: z.string().optional().describe('이모지 아이콘 (예: 🩺)'),
    group: z.string().optional().describe('사이드바 그룹명'),

    model: z.string().min(1).describe('models 에 정의한 모델 이름'),

    fields: z.array(fieldSchema).min(1).describe('입력 폼 정의'),
    requireOneOf: z
      .array(z.string())
      .optional()
      .default([])
      .describe('나열한 필드 중 최소 하나는 입력되어야 실행됩니다.'),
    mcpServers: z
      .array(z.string())
      .optional()
      .default([])
      .describe('mcp.json 에 정의한 서버 이름. 비우면 툴 없이 프롬프트만.'),
    requiresVpn: z
      .boolean()
      .optional()
      .default(false)
      .describe('VPC 내부 자원을 쓰는 앱. 연결되기 전에는 실행 버튼이 잠깁니다.'),
  })
  .describe('앱(폼) 정의');

export const configSchema = z
  .strictObject({
    $schema: z.string().optional().describe('에디터 자동완성용. 서버는 무시합니다.'),
    models: z
      .record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), modelSchema)
      .describe('모델 이름 → 모델 정의. 앱이 이 이름을 참조합니다.'),
    apps: z.array(appSchema).min(1),
  })
  .describe('AI Hub 설정 — 모델과 앱(폼)을 정의합니다.');

export type ParsedConfig = z.output<typeof configSchema>;
export type ParsedModel = z.output<typeof modelSchema>;
export type ParsedApp = z.output<typeof appSchema>;

/** zod 이슈를 `apps[0].fields[1].key: 메시지` 형태의 읽기 쉬운 줄로 편다. */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.reduce<string>((acc, segment) => {
        if (typeof segment === 'number') return `${acc}[${segment}]`;
        return acc === '' ? String(segment) : `${acc}.${String(segment)}`;
      }, '');

      // strict 모드의 기본 문구는 불친절해서 어떤 키가 문제인지 직접 짚어준다.
      if (issue.code === 'unrecognized_keys') {
        const keys = issue.keys.map((k) => `'${k}'`).join(', ');
        return `${path || '(최상위)'}: 알 수 없는 항목 ${keys}`;
      }
      return `${path || '(최상위)'}: ${issue.message}`;
    })
    .join('\n');
}
