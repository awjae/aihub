**GitHub PR에 달린 리뷰 코멘트를 평가·선별해 반영하고 답글까지 남깁니다** — 미해결 스레드 수집 → 반영/보류/반박 분류 → 수정 → 검증 → 커밋·푸시 → 스레드별 답글.

인자: `$ARGUMENTS` (PR 번호 또는 PR URL — 생략 시 현재 브랜치의 PR을 자동 감지)

## Step 1: PR 식별 & 브랜치 정렬

`$ARGUMENTS`(PR 번호/URL, 없으면 현재 브랜치)로 PR을 특정하고, 작업할 head 브랜치로 정렬한다.

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
OWNER=${REPO%/*}; NAME=${REPO#*/}
PRNUM=$(gh pr view $ARGUMENTS --json number -q .number)            # 인자 없으면 현재 브랜치 PR
gh pr view "$PRNUM" --json title,headRefName,baseRefName,state,url
```

- 작업 트리가 dirty면(`git status --short`) 먼저 사용자에게 알리고 정리 여부를 확인한다 — **임의 stash/커밋 금지.**
- head 브랜치가 현재 브랜치와 다르면 `gh pr checkout "$PRNUM"`으로 전환한 뒤 `git pull`로 최신화한다.
- PR이 `MERGED`/`CLOSED`면 반영해도 의미가 적으므로 사용자에게 확인한다.

## Step 2: 미해결 리뷰 코멘트 수집

**미해결(unresolved) 스레드만 대상으로 한다.** resolved/outdated 스레드는 이미 처리됐거나 코드가 바뀐 것이므로 제외한다. bot·사람 코멘트는 모두 포함한다.

GraphQL로 스레드의 resolve 상태까지 한 번에 가져온다 (REST `/pulls/{n}/comments`는 resolve 상태를 주지 않는다):

```bash
gh api graphql -F owner="$OWNER" -F name="$NAME" -F pr="$PRNUM" -f query='
query($owner:String!,$name:String!,$pr:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$pr){
      reviewThreads(first:100){ nodes{
        isResolved isOutdated path line
        comments(first:30){ nodes{ databaseId author{login} body } }
      } }
      reviews(first:50){ nodes{ author{login} state body } }
    }
  }
}' --jq '
  .data.repository.pullRequest as $pr
  | ($pr.reviewThreads.nodes[] | select(.isResolved==false and .isOutdated==false)
     | { path, line, replyToId: .comments.nodes[0].databaseId,
         author: .comments.nodes[0].author.login,
         body: ([.comments.nodes[].body] | join("\n--\n")) })'
```

- `replyToId`(스레드 첫 코멘트의 `databaseId`)는 Step 6에서 답글을 달 때 쓰므로 코멘트별로 보관한다.
- `reviews[].body`(CHANGES_REQUESTED 등 요약 리뷰 본문)도 비어있지 않으면 함께 검토 대상에 넣는다.
- 봇 코멘트는 우선순위 아이콘(🔴/🟡)만 눈에 띄고 정작 제안은 본문에 있다 — **아이콘으로 판단하지 말고 본문을 끝까지 읽는다.**

## Step 3: 평가 & 선별

**수집한 코멘트를 무조건 반영하지 않는다.** 각 지적을 코드·동작과 직접 대조해 타당성을 검증한 뒤 분류한다. (코드 리뷰 수용에 특화된 스킬이 설치돼 있으면 활용하고, 없으면 아래를 직접 수행한다.)

- 컨텍스트로 PR diff(`gh pr diff "$PRNUM"`)와 지적된 파일/라인을 함께 확인한다.

| 분류 | 의미 | 처리 |
|------|------|------|
| **반영** | 타당하고 수정 범위가 명확 | Step 4에서 수정 |
| **보류** | 타당성·범위가 모호하거나 설계 결정이 필요 | 사용자에게 보고 후 결정 |
| **반박** | 사실관계가 틀렸거나 부적절한 제안 | 수정하지 않고 근거와 함께 답글로 회신 |

- 먼저 **분류표를 사용자에게 보여주고**, '보류'·'반박' 항목은 사용자 확인을 받은 뒤 진행한다. '반영' 항목만이면 바로 Step 4로 갈 수 있다.
- **성의상 동의(performative agreement) 금지** — 의심스러우면 코드·동작으로 검증한 근거를 댄다.

## Step 4: 반영 (수정 적용)

'반영'으로 분류된 코멘트를 코드에 적용한다.

- **동일 지적이 같은 결함의 다른 위치에도 있으면 함께 고친다.**
- 봇의 `suggestion` 블록은 참고하되 **맹목 적용 금지** — 저장소 컨벤션(`CLAUDE.md`, 주변 코드)에 맞게 조정해 적용한다.
- 지적이 **규칙 문서**(`CLAUDE.md` 등 저장소가 쓰는 룰 문서)의 내용과 관련되거나 그 규칙 자체를 바꿔야 하는 경우, 코드와 문서를 **함께** 갱신한다. 규칙 문서가 여러 곳(루트/디렉터리별/리뷰봇용)에 나뉘어 있으면 한 곳만 고쳐 서로 어긋나게 두지 않는다.
- **수정 중 새로운 모호함이 드러나면 멈추고 사용자에게 확인한다.**

## Step 5: 검증 & 커밋·푸시

저장소가 제공하는 검증 스크립트(lint·typecheck·build·test) 중 **실재하는 것만** 돌린다. 무엇이 있는지는 `CLAUDE.md` → `package.json`(scripts) → `Makefile` 순으로 확인하고, **없는 스크립트를 지어내지 않는다.** 정의된 것이 하나도 없으면 그 사실을 보고한다.

- 오류가 있으면 수정 후 재실행한다. 통과하지 못하면 커밋하지 않는다.
- 문서·`.claude/` 등 빌드 영향이 없는 변경만 있으면 생략하고, 무엇으로 확인했는지 보고한다.

검증을 통과하면 커밋·푸시한다.

- 커밋 메시지 형식은 **저장소 컨벤션**을 따른다 — `CLAUDE.md`의 규약과 `git log --oneline -20`의 최근 이력에서 확인한다. 본문에 어떤 지적을 어떻게 반영했는지 항목으로 적는다.
- 커밋 말미에 `Co-Authored-By: Claude ...` 트레일러를 붙인다.
- **현재 브랜치(= PR head)로만 push한다.** 다른 브랜치로 푸시하지 않는다.

## Step 6: 코멘트 답글

반영·보류·반박 결과를 각 스레드에 답글로 남겨 리뷰어에게 피드백한다. **스레드 resolve는 이 커맨드가 하지 않는다** — 작성자·리뷰어 판단에 맡긴다.

```bash
# 스레드 첫 코멘트(replyToId)에 답글
gh api --method POST "repos/$REPO/pulls/$PRNUM/comments/$REPLY_TO_ID/replies" \
  -f body="반영했습니다 (<커밋 해시>). <간단한 처리 요약>"
```

- **반영**: 반영했다는 사실 + 커밋 해시.
- **보류**: 사용자와 합의된 결정/사유.
- **반박**: 수정하지 않은 이유와 근거를 정중하게.
- 요약 리뷰 본문(`reviews[].body`)에 대한 총평이 필요하면 PR 코멘트로 남긴다: `gh pr comment "$PRNUM" --body "..."`.

마지막으로 처리 결과(반영 N건 / 보류 N건 / 반박 N건)와 커밋·푸시 결과를 사용자에게 요약 보고한다.
