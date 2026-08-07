// 컨테이너 안에서 실행된다. 질의 생성기가 스키마 카탈로그를 찾고
// SQL 까지 만들어내는지 확인한다 — LLM·DB 없이 확인되는 지점까지만 본다.
import { spawnSync } from 'node:child_process';

const entry = process.env.AKITA_QUERY_CLI;
if (!entry) {
  console.error('AKITA_QUERY_CLI 가 이미지에 설정되어 있지 않습니다.');
  process.exit(1);
}

// LLM_MODEL 없이 부르면 구성 단계에서 실패한다. 그 실패가 --json 으로
// 오면 진입 파일·의존성·JSON 규약이 모두 살아 있다는 뜻이다.
const probe = spawnSync(process.execPath, [entry, '테스트 질문', '--json'], {
  env: { ...process.env, LLM_MODEL: '', OPENAI_API_KEY: '' },
  encoding: 'utf8',
});

const line = (probe.stderr || probe.stdout).trim().split('\n').pop() ?? '';
let payload;
try {
  payload = JSON.parse(line);
} catch {
  console.error(`[build-image] 질의 생성기가 JSON 을 내지 않았습니다: ${line.slice(0, 200)}`);
  process.exit(1);
}
console.log(`[build-image] 질의 생성기: ok=${payload.ok} code=${payload.code ?? '-'}`);

// 스키마 카탈로그가 이미지에 함께 구워졌는지 — 경로가 어긋나면 여기서 드러난다.
const { SchemaLoader } = await import('/app/akita/src/ai/schema-retrieval/schema-loader.ts');
const catalog = await new SchemaLoader().load();
console.log(`[build-image] 스키마 카탈로그: 엔티티 ${catalog.entities.length}개`);
