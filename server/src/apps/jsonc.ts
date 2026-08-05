/**
 * 주석과 후행 쉼표를 허용하는 JSON 파서 (JSONC — tsconfig.json 과 같은 방언).
 *
 * 설정 파일에 주석을 못 다는 건 실무에서 꽤 아픈 제약이라 허용한다.
 * 문자열 리터럴 안의 `//` (예: "https://…") 를 주석으로 오인하지 않도록
 * 문자 단위로 스캔한다.
 */

/** 주석을 공백으로 치환한다. 줄바꿈은 남겨 파싱 에러의 줄 번호를 보존한다. */
function stripComments(text: string): string {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        out += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      } else if (char === '\n') {
        out += char;
      }
      continue;
    }

    if (inString) {
      out += char;
      if (char === '\\') {
        // 이스케이프된 문자는 그대로 통과 — \" 를 문자열 종료로 오인하지 않는다.
        out += text[i + 1] ?? '';
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '/' && next === '/') {
      inLineComment = true;
      i += 1;
    } else if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
    } else {
      out += char;
    }
  }

  return out;
}

/** `,` 뒤에 `}` 나 `]` 만 오는 후행 쉼표를 제거한다. 문자열 안의 쉼표는 건드리지 않는다. */
function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      out += char;
      if (char === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === ',') {
      // 다음 non-whitespace 가 닫는 괄호면 이 쉼표는 버린다.
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === '}' || text[j] === ']') continue;
    }

    out += char;
  }

  return out;
}

/** 에러 위치(문자 오프셋)를 줄:칸 으로 바꿔 어디가 문제인지 짚어준다. */
function locate(text: string, offset: number): string {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  const column = offset - before.lastIndexOf('\n');
  return `${line}번째 줄, ${column}번째 칸`;
}

export function parseJsonc(text: string, filePath: string): unknown {
  const cleaned = stripTrailingCommas(stripComments(text));

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const offset = /position (\d+)/.exec(message)?.[1];
    const where = offset ? ` (${locate(cleaned, Number(offset))})` : '';
    throw new Error(`${filePath}: JSON 형식이 올바르지 않습니다${where} — ${message}`);
  }
}
