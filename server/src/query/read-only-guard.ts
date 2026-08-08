/**
 * 생성된 SQL 에 대한 보수적 렉시컬 가드.
 *
 * ⚠️ 정본은 akita_schema 의 `src/ai/execution/sql-executor.ts` 다. 실행이 이쪽으로
 *    옮겨오면서 **구현을 그대로 가져왔다** — 새로 쓰지 않았다. 저쪽이 바뀌면
 *    여기도 맞춰야 한다.
 *
 * 생성기가 SELECT 만 만들지만, 그건 생성기에 버그가 없다는 전제다. 커넥션 풀의
 * `default_transaction_read_only=on` 과 함께 두 겹으로 막는다.
 */
export class SqlReadOnlyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlReadOnlyViolationError';
  }
}

export function assertReadOnlySingleStatement(text: string): void {
    if (typeof text !== 'string' || text.trim().length === 0) {
        throw new SqlReadOnlyViolationError(
            'SQL text must be a non-empty SELECT statement',
        );
    }

    let firstToken: string | undefined;
    let index = 0;
    while (index < text.length) {
        const char = text[index];
        const next = text[index + 1];

        if (char === '-' && next === '-') {
            index = skipLineComment(text, index + 2);
            continue;
        }
        if (char === '/' && next === '*') {
            index = skipBlockComment(text, index + 2);
            continue;
        }
        if (char === "'") {
            index = skipQuoted(text, index + 1, "'", 'string literal');
            continue;
        }
        if (char === '"') {
            index = skipQuoted(text, index + 1, '"', 'quoted identifier');
            continue;
        }
        if (char === '$') {
            const tag = readDollarQuoteTag(text, index);
            if (tag !== null) {
                const end = text.indexOf(tag, index + tag.length);
                if (end === -1) {
                    throw new SqlReadOnlyViolationError(
                        'Unterminated dollar-quoted string',
                    );
                }
                index = end + tag.length;
                continue;
            }
        }
        if (char === ';') {
            throw new SqlReadOnlyViolationError(
                'Multiple statements and statement separators are not allowed',
            );
        }
        if (char !== undefined && /[A-Za-z_]/.test(char)) {
            const tokenStart = index;
            index += 1;
            while (
                index < text.length &&
                /[A-Za-z0-9_$]/.test(text[index] ?? '')
            ) {
                index += 1;
            }
            firstToken ??= text.slice(tokenStart, index).toUpperCase();
            continue;
        }
        index += 1;
    }

    if (firstToken !== 'SELECT') {
        throw new SqlReadOnlyViolationError(
            'Only a single SELECT statement may be executed',
        );
    }
}

function skipLineComment(text: string, start: number): number {
    const end = text.indexOf('\n', start);
    return end === -1 ? text.length : end + 1;
}

function skipBlockComment(text: string, start: number): number {
    let depth = 1;
    let index = start;
    while (index < text.length) {
        if (text[index] === '/' && text[index + 1] === '*') {
            depth += 1;
            index += 2;
            continue;
        }
        if (text[index] === '*' && text[index + 1] === '/') {
            depth -= 1;
            index += 2;
            if (depth === 0) {
                return index;
            }
            continue;
        }
        index += 1;
    }
    throw new SqlReadOnlyViolationError('Unterminated block comment');
}

function skipQuoted(
    text: string,
    start: number,
    quote: "'" | '"',
    label: string,
): number {
    let index = start;
    while (index < text.length) {
        if (text[index] === '\\') {
            index += 2;
            continue;
        }
        if (text[index] === quote) {
            if (text[index + 1] === quote) {
                index += 2;
                continue;
            }
            return index + 1;
        }
        index += 1;
    }
    throw new SqlReadOnlyViolationError(`Unterminated ${label}`);
}

function readDollarQuoteTag(text: string, start: number): string | null {
    const match = text.slice(start).match(
        /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/,
    );
    return match?.[0] ?? null;
}
