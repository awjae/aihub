import { ParsedApp, ParsedModel } from './schema';

export type ModelDefinition = ParsedModel & { id: string };
export type AppDefinition = ParsedApp;

export type FieldDefinition = AppDefinition['fields'][number];
export type ResponseFormat = ModelDefinition['responseFormat'];

/**
 * 앱과 그 앱이 참조하는 모델을 함께 묶은, 실행에 필요한 모든 것.
 * direct 모드는 모델을 쓰지 않으므로 model 이 없다.
 */
export interface ResolvedApp {
  app: AppDefinition;
  model: ModelDefinition | null;
}

/**
 * 프론트로 내려보내는 형태.
 * 모델 ID·프롬프트 등 내부 정보는 빼고, 화면을 그리는 데 필요한 것만 담는다.
 * responseFormat 은 모델이 소유하지만 파싱은 프론트가 하므로 함께 내려준다.
 */
export interface PublicAppDefinition {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  group?: string;
  fields: FieldDefinition[];
  requireOneOf: string[];
  responseFormat: ResponseFormat;
  /** query 면 답변 문장 없이 결과를 표로 그린다. */
  mode: 'model' | 'query';
  /** VPC 내부 자원을 쓰는 앱. 프론트가 VPN 상태로 실행을 막는다. */
  requiresVpn: boolean;
}

export function toPublic({ app, model }: ResolvedApp): PublicAppDefinition {
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    icon: app.icon,
    group: app.group,
    fields: app.fields,
    requireOneOf: app.requireOneOf,
    responseFormat: model?.responseFormat ?? { type: 'text' },
    mode: app.mode,
    requiresVpn: app.requiresVpn,
  };
}
