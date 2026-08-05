/**
 * zod 스키마 → JSON Schema 생성기.
 *
 * 검증 규칙의 출처는 src/apps/schema.ts 하나뿐이고, 에디터가 읽는
 * config/apps.schema.json 은 여기서 만들어진 산출물이다.
 * 손으로 고치지 말 것 — `npm run schema` 로 다시 생성된다.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

import { configSchema } from '../src/apps/schema';

const outputPath = resolve(__dirname, '../../config/apps.schema.json');

const jsonSchema = z.toJSONSchema(configSchema, {
  // 기본값·transform 이 있는 필드도 "입력" 기준으로 뽑아야 사람이 쓰는 형태와 맞는다.
  io: 'input',
  // $ref 로 쪼개지 않고 펼쳐야 에디터 툴팁에 설명이 잘 붙는다.
  reused: 'inline',
});

const banner = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'AI Hub 설정',
  $comment: '자동 생성 파일입니다. 손으로 고치지 마세요 — server/npm run schema 로 재생성됩니다.',
};

writeFileSync(outputPath, `${JSON.stringify({ ...banner, ...jsonSchema }, null, 2)}\n`, 'utf8');
console.log(`생성 완료: ${outputPath}`);
