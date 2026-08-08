import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';

import { AppConfig, CONFIG } from '../config/configuration';
import { AppDefinition, FieldDefinition, ModelDefinition, ResolvedApp } from './app-definition';
import { parseJsonc } from './jsonc';
import { configSchema, formatIssues } from './schema';

/** `{{key}}` — 프롬프트 템플릿의 플레이스홀더 */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

@Injectable()
export class AppsService implements OnModuleInit {
  private readonly logger = new Logger(AppsService.name);
  private apps = new Map<string, ResolvedApp>();

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  onModuleInit(): void {
    this.load();
  }

  /** 설정 파일을 다시 읽어 메모리에 반영. 실패하면 기존 정의를 유지한다. */
  load(): { models: number; apps: number } {
    const path = this.config.appsConfigPath;
    const parsed = parseJsonc(readFileSync(path, 'utf8'), path);

    const result = configSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`${path}\n${formatIssues(result.error)}`);
    }

    const { models, apps } = result.data;
    const next = new Map<string, ResolvedApp>();

    for (const [index, app] of apps.entries()) {
      const at = `apps[${index}] ('${app.id}')`;

      if (next.has(app.id)) throw new Error(`${at}: 앱 id 가 중복됩니다.`);

      // query 모드는 모델을 거치지 않는다 — 조회 결과가 그대로 화면으로 간다.
      let model: ModelDefinition | null = null;
      if (app.mode === 'model') {
        const modelDef = models[app.model as string];
        if (!modelDef) {
          const available = Object.keys(models).join(', ') || '(없음)';
          throw new Error(
            `${at}.model: '${app.model}' 모델이 models 에 없습니다. 사용 가능: ${available}`,
          );
        }
        model = { ...modelDef, id: app.model as string };
        this.checkTemplateKeys(app, model.userTemplate, `모델 '${model.id}' 의 userTemplate`, at);
      } else {
        this.checkTemplateKeys(app, app.questionTemplate as string, 'questionTemplate', at);
      }

      this.checkRequireOneOf(app, at);

      next.set(app.id, { app, model });
    }

    this.apps = next;
    this.logger.log(
      `설정 로드 완료: 모델 ${Object.keys(models).length}개, 앱 ${next.size}개 (${path})`,
    );
    return { models: Object.keys(models).length, apps: next.size };
  }

  list(): ResolvedApp[] {
    return [...this.apps.values()];
  }

  get(id: string): ResolvedApp {
    const resolved = this.apps.get(id);
    if (!resolved) throw new NotFoundException(`'${id}' 앱을 찾을 수 없습니다.`);
    return resolved;
  }

  /**
   * 폼 입력값을 검증하고 모델의 userTemplate 을 렌더링한다.
   * 정의되지 않은 키는 무시하므로 프론트가 임의 값을 넣어도 프롬프트에 섞이지 않는다.
   */
  renderPrompt({ app, model }: ResolvedApp, input: Record<string, unknown>): string {
    if (!model) throw new Error(`앱 '${app.id}' 는 모델이 없습니다 (direct 모드).`);
    return this.renderWithTemplate(app, model.userTemplate, input);
  }

  /** direct 모드: 폼 입력값을 질의 생성기에 넘길 질문 한 줄로 렌더링한다. */
  renderQuestion(
    { app }: ResolvedApp,
    input: Record<string, unknown>,
  ): string {
    if (!app.questionTemplate) {
      throw new Error(`앱 '${app.id}' 에 questionTemplate 이 없습니다.`);
    }
    return this.renderWithTemplate(app, app.questionTemplate, input);
  }

  private renderWithTemplate(
    app: AppDefinition,
    template: string,
    input: Record<string, unknown>,
  ): string {
    const values = new Map<string, string>();
    const filled = new Set<string>();

    for (const field of app.fields) {
      const raw = input[field.key];

      // 기본값은 "항목을 아예 안 보냈을 때"만 적용한다.
      // 빈 문자열은 사용자가 폼을 지운 것이므로 되살리면 안 된다.
      // (프론트는 폼을 그릴 때 이미 기본값을 채워 넣는다)
      const provided = raw !== undefined && raw !== null;
      const value = provided ? raw : field.default;

      if (value === undefined || value === null || value === '') {
        if (field.required) {
          throw new BadRequestException(`'${field.label}' 항목은 필수입니다.`);
        }
        values.set(field.key, '');
        continue;
      }

      const text = this.coerce(field, value);
      values.set(field.key, text);
      if (text !== '') filled.add(field.key);
    }

    if (app.requireOneOf.length > 0 && !app.requireOneOf.some((key) => filled.has(key))) {
      const labels = app.requireOneOf.map(
        (key) => app.fields.find((f) => f.key === key)?.label ?? key,
      );
      throw new BadRequestException(`${labels.join(', ')} 중 최소 하나는 입력해야 합니다.`);
    }

    return this.renderTemplate(template, values);
  }

  /**
   * {{key}} 를 치환하되, **플레이스홀더가 전부 비어 있는 줄은 통째로 제거**한다.
   * 입력하지 않은 항목의 라벨(`Subjective)` 같은)이 빈 채로 프롬프트에 남으면
   * 학습 데이터와 형식이 어긋나기 때문.
   */
  private renderTemplate(template: string, values: Map<string, string>): string {
    const kept: string[] = [];

    for (const line of template.split('\n')) {
      const keys = this.templateKeys(line).filter((key) => values.has(key));
      if (keys.length > 0 && keys.every((key) => values.get(key) === '')) continue;

      kept.push(
        line.replace(PLACEHOLDER, (match, key: string) =>
          values.has(key) ? (values.get(key) as string) : match,
        ),
      );
    }

    return kept.join('\n');
  }

  private coerce(field: FieldDefinition, value: unknown): string {
    switch (field.type) {
      case 'select': {
        const str = String(value);
        if (field.options && !field.options.includes(str)) {
          throw new BadRequestException(`'${field.label}' 값이 허용된 선택지가 아닙니다.`);
        }
        return str;
      }
      case 'number': {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          throw new BadRequestException(`'${field.label}' 은(는) 숫자여야 합니다.`);
        }
        if (field.min !== undefined && n < field.min) {
          throw new BadRequestException(`'${field.label}' 은(는) ${field.min} 이상이어야 합니다.`);
        }
        if (field.max !== undefined && n > field.max) {
          throw new BadRequestException(`'${field.label}' 은(는) ${field.max} 이하여야 합니다.`);
        }
        return String(n);
      }
      case 'checkbox':
        return value === true || value === 'true' ? '예' : '아니오';
      default: {
        // 앞뒤 공백은 프롬프트 노이즈일 뿐이고, 공백만 입력해 길이 제한을 피하는 것도 막는다.
        const text = Array.isArray(value) ? value.join('\n').trim() : String(value).trim();
        if (field.minLength !== undefined && text.length < field.minLength) {
          throw new BadRequestException(
            `'${field.label}' 은(는) 최소 ${field.minLength}자 이상 입력해야 합니다.`,
          );
        }
        if (field.maxLength !== undefined && text.length > field.maxLength) {
          throw new BadRequestException(
            `'${field.label}' 은(는) 최대 ${field.maxLength}자까지 입력할 수 있습니다.`,
          );
        }
        return text;
      }
    }
  }

  // ── 앱↔모델 교차 검증 (zod 스키마 하나로는 볼 수 없는 것들) ────

  /** 템플릿이 요구하는 {{key}} 를 앱이 전부 제공하는지. 어긋나면 빈칸이 남는다. */
  private checkTemplateKeys(
    app: AppDefinition,
    template: string,
    label: string,
    at: string,
  ): void {
    const provided = new Set(app.fields.map((field) => field.key));
    const duplicates = app.fields.length - provided.size;
    if (duplicates > 0) throw new Error(`${at}.fields: key 가 중복됩니다.`);

    const missing = [...new Set(this.templateKeys(template))].filter(
      (key) => !provided.has(key),
    );

    if (missing.length > 0) {
      throw new Error(
        `${at}: ${label} 이(가) 요구하는 ` +
          `${missing.map((k) => `{{${k}}}`).join(', ')} 에 대응하는 field 가 없습니다.`,
      );
    }
  }

  private checkRequireOneOf(app: AppDefinition, at: string): void {
    const keys = new Set(app.fields.map((field) => field.key));
    for (const key of app.requireOneOf) {
      if (!keys.has(key)) {
        throw new Error(`${at}.requireOneOf: '${key}' 에 대응하는 field 가 없습니다.`);
      }
    }
  }

  private templateKeys(template: string): string[] {
    return [...template.matchAll(PLACEHOLDER)].map((match) => match[1]);
  }
}
