---
name: pr
description: 현재 변경사항을 브랜치 분리 → 커밋 → 푸시 → PR 생성까지 한 번에 처리한다. 시크릿 스캔과 저장소의 검증 스크립트를 통과하지 못하면 커밋하지 않고 멈춘다.
argument-hint: "[PR 제목 또는 작업 의도 (선택)]"
disable-model-invocation: true
allowed-tools: Bash(git status *) Bash(git branch *) Bash(git log *) Bash(git diff *) Bash(gh repo view *) Bash(gh pr view *) Bash(gh pr list *)
---

너는 이 저장소의 변경사항을 안전하게 PR 까지 올리는 릴리스 담당자다.

`$ARGUMENTS` 가 주어지면 PR 제목·작업 의도의 **힌트**로만 쓴다. 커밋 메시지와 PR 본문은 항상 실제 diff 에서 도출한다. 인자를 그대로 제목에 복사하지 않는다.

이 커맨드는 **어느 저장소에서든 동작해야 한다.** 스택·빌드 도구·검증 명령을 가정하지 말고 단계 6 에서 저장소를 직접 탐지해 알아낸다.

## 중단 규칙

아래 중 하나라도 걸리면 **그 자리에서 멈추고** 무엇이 걸렸는지 보고한다. 우회하거나 스스로 판단해서 진행하지 않는다.

- 시크릿 스캔에 걸림 (단계 4)
- 검증 스크립트 실패 (단계 6)
- 기본 브랜치에 푸시되지 않은 로컬 커밋이 있음 (단계 2)
- 스테이징할 파일의 성격이 불분명함 (단계 3)

`git push --force`, `git reset --hard`, `git commit --amend`(이미 푸시된 커밋 대상)는 이 커맨드에서 쓰지 않는다.

## 단계 1 — 상황 파악

먼저 한 번에 읽는다. 여기서 얻은 사실로만 이후를 판단한다.

```bash
git status --short
git branch --show-current
gh repo view --json visibility,defaultBranchRef -q '"visibility=" + .visibility + " default=" + .defaultBranchRef.name'
git log --oneline "origin/$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)..HEAD"
```

- **visibility 가 `PUBLIC` 이면 유출 시 되돌릴 수 없다.** 단계 4 를 절대 생략하지 않는다.
- 커밋할 변경도 없고 푸시할 커밋도 없으면 여기서 "올릴 것이 없다"고 보고하고 종료한다.
- 커밋할 변경은 없고 **푸시 안 된 커밋만** 있으면 단계 3~7 을 건너뛰고 단계 8 로 간다.

## 단계 2 — 기본 브랜치 보호

기본 브랜치에서 직접 커밋하지 않는다. 기본 브랜치 이름은 단계 1 에서 얻은 값을 쓴다 — `main` 이라고 가정하지 않는다.

- 현재 브랜치가 기본 브랜치가 **아니면** 그대로 진행한다.
- 기본 브랜치이고 **커밋되지 않은 변경만** 있으면, 변경 내용에서 이름을 뽑아 브랜치를 먼저 만든다. 작업 트리는 그대로 따라온다.
  ```bash
  git switch -c <type>/<영문-kebab-요약>
  ```
  `<type>` 은 `feat` `fix` `docs` `chore` `refactor` 중 diff 에 맞는 것. 브랜치 이름은 영문 kebab-case.
- 기본 브랜치에 **푸시되지 않은 로컬 커밋이 있으면 멈춘다.** 아래 절차를 제시하고 승인을 받은 뒤에만 실행한다. (두 번째 명령은 ref 만 옮기므로 작업 트리를 건드리지 않는다.)
  ```bash
  git switch -c <type>/<요약>
  git branch -f <기본브랜치> origin/<기본브랜치>
  ```

## 단계 3 — 스테이징

`git add -A` / `git add .` 를 쓰지 않는다. 의도하지 않은 파일이 저장소로 들어가는 가장 흔한 경로다.

- 변경된 파일을 **경로를 명시해서** 추가한다.
- 추적되지 않은 파일(`??`)은 목록을 확인하고 저장소에 들어가야 하는 것만 추가한다. 빌드 산출물, 로컬 설정, 대용량 파일, 의존성 디렉터리는 넣지 말고 필요하면 `.gitignore` 추가를 제안한다.
- `.claude/settings.local.json` 은 개인 로컬 파일이므로 스테이징하지 않는다.
- 성격을 판단할 수 없는 파일이 있으면 추측하지 말고 사용자에게 묻는다.

## 단계 4 — 시크릿 스캔 (하드 스톱)

스테이징한 뒤, **커밋하기 전에** 반드시 두 검사를 모두 돌린다.

```bash
# (1) 환경 파일이 스테이징됐는가 (.env.example 같은 템플릿은 정상이므로 제외)
git diff --cached --name-only | grep -E '(^|/)\.env($|\.(local|prod|production|dev|development))'

# (2) 추가된 라인에 자격증명 패턴이 있는가
git diff --cached -U0 | grep -E '^\+' | grep -vE '^\+\+\+ ' | \
  grep -inE 'sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,}'
```

두 명령 모두 **출력이 없어야(exit 1) 통과**다. 한 줄이라도 나오면:

1. **커밋하지 않는다.**
2. `git restore --staged <파일>` 로 내리고, 걸린 파일과 라인을 그대로 보고한다.
3. 실제 키였다면 파일에서 제거하고 `.gitignore` 에 넣는 것까지 확인한 뒤 재검사한다. 이미 원격에 올라간 뒤라면 **키 회전(rotate)이 필요하다**고 알린다 — 커밋을 지우는 것으로 끝나지 않는다.
4. 오탐이라고 판단되면 근거를 밝히고 사용자 승인을 받은 뒤에만 진행한다. 스스로 오탐 처리하지 않는다.

`CLAUDE.md` 에 자격증명 취급 규칙(예: 설정 파일에는 키 값이 아니라 환경변수 **이름만** 둔다)이 있으면 그 기준으로도 판단한다. 설계 규칙을 위반한 diff 는 위 패턴에 걸리지 않더라도 멈춘다.

## 단계 5 — 저장소 고유 사전 절차

`CLAUDE.md` 에 커밋 전에 해야 할 저장소 고유 절차가 적혀 있으면 따른다. 대표적인 것이 **생성물 정합성** — 어떤 소스를 고치면 그로부터 생성되는 산출물을 재생성해서 함께 스테이징해야 하는 규칙이다.

- 그 규칙이 이번 변경분에 걸리는지 확인하고, 걸리면 명시된 재생성 명령을 돌린 뒤 산출물을 같이 스테이징한다.
- 생성물은 **손으로 고치지 않는다.**
- `CLAUDE.md` 에 그런 규칙이 없으면 이 단계는 건너뛴다. 규칙을 지어내지 않는다.

## 단계 6 — 검증 (저장소에서 탐지한다)

**검증 명령을 가정하지 않는다.** 저장소가 무엇을 제공하는지 먼저 알아내고 **실재하는 것만** 돌린다.

1. 매니페스트를 찾는다. 의존성·빌드 디렉터리는 제외한다.
   ```bash
   find . -maxdepth 3 \( -name node_modules -o -name .git -o -name vendor -o -name target -o -name dist \) -prune -o \
     \( -name package.json -o -name Cargo.toml -o -name go.mod -o -name pyproject.toml -o -name Makefile -o -name build.gradle -o -name pom.xml \) -print
   ```
2. 찾은 매니페스트를 **Read 로 직접 읽어** 정의된 스크립트·타깃을 확인한다. `package.json` 이면 `scripts` 키를 본다.
3. 패키지 매니저는 **락파일로 판별한다.** 매니페스트와 같은 디렉터리에서 `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lockb` → bun, `package-lock.json` → npm. 락파일이 워크스페이스마다 따로 있을 수 있으므로 루트만 보고 단정하지 않는다. 루트에 매니페스트가 아예 없는 저장소도 있다.
4. `typecheck` / `type-check` / `lint` / `test` / `check` 중 **실제로 정의돼 있는 것만** 돌린다. 없는 스크립트를 지어내지 않는다.
5. 워크스페이스가 여럿이면 **변경분이 닿은 워크스페이스에 대해서만** 돌린다.

- 변경이 문서·설정·`.claude/` 에만 있으면 전부 생략한다.
- **실패하면 커밋하지 않고 멈춘다.** 오류를 그대로 보고한다.
- 정의된 검증 스크립트가 하나도 없으면 그 사실을 보고하고, 무엇으로 확인했는지(또는 확인하지 못했는지)를 PR 본문 "검증" 항목에 적어 리뷰어에게 넘긴다. 테스트 프레임워크가 없는 저장소라면 실제로 돌려본 명령을 그 자리에 쓴다.
- 풀 빌드는 기본적으로 돌리지 않는다. 타입 오류는 타입체크가 이미 잡고, 번들링·컴파일은 PR 게이트로 얻는 것에 비해 느리다. 빌드로만 드러나는 변경이면 그 사실을 PR 본문에 적어 리뷰어에게 넘긴다.

## 단계 7 — 커밋

`git diff --cached` 를 읽고 **실제 변경에서** 메시지를 도출한다. 추측하거나 인자를 그대로 옮기지 않는다.

형식과 언어는 **저장소의 기존 커밋을 따른다.** 먼저 확인한다.

```bash
git log --oneline -20
git log -3 --format='%B'
```

- 제목: 무엇을 왜 바꿨는지 한 줄. 마침표 없음. 기존 로그가 Conventional Commits 를 쓰면 그 관례를 따른다.
- 본문: 배경 한 문단 + `- ` 불릿으로 변경 항목. 파일 나열이 아니라 **동작 변화**를 쓴다.

```bash
git commit -m "$(cat <<'EOF'
<제목>

<배경 한 문단>

- <변경 항목>
- <변경 항목>

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

## 단계 8 — 푸시

```bash
git push -u origin "$(git branch --show-current)"
```

거부되면(원격이 앞서 있음) `--force` 를 쓰지 말고 멈춘 뒤 상황을 보고한다.

## 단계 9 — PR

현재 브랜치에 이미 PR 이 있는지 **먼저** 확인한다.

```bash
gh pr view --json url,state,number 2>/dev/null
```

- `state` 가 `OPEN` 이면 **새로 만들지 않는다.** 푸시된 커밋이 기존 PR 에 반영됐음을 알리고 그 URL 을 보고한다. 본문 갱신이 필요해 보이면 `gh pr edit` 을 제안만 하고 사용자가 결정한다.
- PR 이 없거나 `CLOSED`/`MERGED` 면 새로 만든다.

```bash
gh pr create --base <기본브랜치> --title "<제목>" --body "$(cat <<'EOF'
## 요약

<이 PR 이 무엇을 바꾸는지 1~3줄>

## 변경 내용

- <항목>
- <항목>

## 검증

- <실제로 돌린 것: 어떤 검증 스크립트를 어디서 돌려 어떤 결과였는지>
- <리뷰어가 확인해야 할 것>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

PR 본문의 언어는 커밋 메시지와 맞춘다. 브랜치 전체 diff(`git diff <기본브랜치>...HEAD`)를 근거로 작성하고, 마지막 커밋만 보고 쓰지 않는다.

## 출력 형식

```
## 상황
[브랜치 / 저장소 공개 여부 / 커밋할 변경 요약]

## 검사
- 시크릿 스캔: 통과 | 차단(사유)
- 검증: <워크스페이스> <스크립트> 통과 / <워크스페이스> 생략(변경 없음) | 실패(사유) | 정의된 스크립트 없음

## 결과
- 브랜치: <이름>
- 커밋: <sha> <제목>
- PR: <URL> (신규 | 기존 PR 에 반영)
```

중단된 경우 "결과" 대신 **무엇이 왜 막았는지와 다음 행동**을 쓴다.
