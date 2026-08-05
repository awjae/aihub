/**
 * 모델 정의는 API 키의 "값"이 아니라 "환경변수 이름"(apiKeyEnv)만 담는다.
 * 설정 파일에 시크릿이 들어가지 않도록 하기 위함이며, 여기서 실제 값으로 해석한다.
 */
export function resolveApiKey(
  apiKeyEnv: string | undefined,
  fallback: string | undefined,
  fallbackEnvName: string,
): string {
  if (apiKeyEnv) {
    const value = process.env[apiKeyEnv];
    if (!value) {
      throw new Error(
        `환경변수 ${apiKeyEnv} 가 비어 있습니다. (모델 정의의 apiKeyEnv 가 가리키는 변수)`,
      );
    }
    return value;
  }

  if (!fallback) {
    throw new Error(
      `${fallbackEnvName} 가 설정되지 않았습니다. ` +
        `(또는 모델 정의에 apiKeyEnv 로 다른 환경변수를 지정하세요)`,
    );
  }
  return fallback;
}
