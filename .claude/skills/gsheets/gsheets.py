#!/usr/bin/env python3
"""Google Sheets 읽기·쓰기 CLI (도구 비의존 — 어떤 터미널에서든 동작).

터미널을 쓸 수 있는 환경이면 어디서든 같은 명령으로 쓴다. 표준 라이브러리만 사용한다.
최초 설정은 같은 디렉터리의 SETUP.md 참조.

읽기:
  gsheets.py tabs   <ID|URL>
  gsheets.py values <ID|URL> <범위>
  gsheets.py grid   <ID|URL> <범위>            값 + 배경색(hex)
  gsheets.py dump   <ID|URL> [--gid N]

쓰기 (쓰기 스코프로 인증돼 있어야 한다):
  gsheets.py set    <ID|URL> <범위> [--tsv 파일|-]     범위를 덮어쓴다
  gsheets.py append <ID|URL> <탭|범위> [--tsv 파일|-]  표 끝에 행 추가
  gsheets.py clear  <ID|URL> <범위> --yes              값 삭제

공통 옵션: --json
"""

import argparse
import hashlib
import json
import os
import platform
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

KEYCHAIN_SERVICE = "gsheets-oauth"
CONFIG_PATH = os.path.expanduser("~/.config/gsheets/credentials.json")
CACHE_PATH = os.path.expanduser("~/.cache/gsheets/token.json")
API = "https://sheets.googleapis.com/v4/spreadsheets"


# ---------------------------------------------------------------- 자격증명 해석
# 이식성을 위해 3단계로 찾는다: 환경변수 → macOS 키체인 → 설정 파일(Linux·컨테이너·CI).


def _keychain_get(account: str) -> str | None:
    if platform.system() != "Darwin":
        return None
    r = subprocess.run(
        ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
        capture_output=True,
        text=True,
    )
    return r.stdout.strip() if r.returncode == 0 else None


def _file_creds() -> dict:
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def load_credentials() -> dict:
    """client_id·client_secret·refresh_token을 반환한다."""
    creds: dict = {}

    raw_client = _keychain_get("client")
    if raw_client:
        creds.update(json.loads(raw_client))
    refresh = _keychain_get("refresh_token")
    if refresh:
        creds["refresh_token"] = refresh

    for k, v in _file_creds().items():
        creds.setdefault(k, v)

    # 환경변수가 있으면 최우선 (CI·컨테이너에서 주입)
    for key, env in (
        ("client_id", "GSHEETS_CLIENT_ID"),
        ("client_secret", "GSHEETS_CLIENT_SECRET"),
        ("refresh_token", "GSHEETS_REFRESH_TOKEN"),
    ):
        if os.environ.get(env):
            creds[key] = os.environ[env]

    missing = [k for k in ("client_id", "client_secret", "refresh_token") if not creds.get(k)]
    if missing:
        sys.exit(
            f"자격증명이 없습니다(누락: {', '.join(missing)}).\n"
            "처음이라면 같은 디렉터리의 SETUP.md를 따라 `python3 -u auth.py`를 실행하세요.\n"
            "CI·컨테이너라면 GSHEETS_CLIENT_ID / GSHEETS_CLIENT_SECRET / GSHEETS_REFRESH_TOKEN 환경변수를 설정하세요."
        )
    return creds


def _cred_fingerprint(creds: dict) -> str:
    """자격증명 지문. 값 자체는 캐시에 남기지 않고 변경 감지에만 쓴다."""
    raw = f"{creds.get('client_id', '')}|{creds.get('refresh_token', '')}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def access_token() -> str:
    """캐시된 access token을 쓴다. 만료 60초 전이거나 자격증명이 바뀌면 갱신한다.

    자격증명 지문을 함께 저장하는 이유: CI·컨테이너에서 GSHEETS_REFRESH_TOKEN을 바꿔도
    만료 시각만 보면 이전 계정의 토큰을 최대 1시간 동안 계속 쓰게 된다.
    """
    creds = load_credentials()
    fingerprint = _cred_fingerprint(creds)

    try:
        with open(CACHE_PATH, encoding="utf-8") as f:
            cached = json.load(f)
        if cached.get("cred") == fingerprint and cached.get("expires_at", 0) - 60 > time.time():
            return cached["access_token"]
    except (OSError, json.JSONDecodeError, KeyError):
        pass

    payload = urllib.parse.urlencode(
        {
            "client_id": creds["client_id"],
            "client_secret": creds["client_secret"],
            "refresh_token": creds["refresh_token"],
            "grant_type": "refresh_token",
        }
    ).encode()
    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=payload,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            tok = json.load(resp)
    except urllib.error.HTTPError as e:
        sys.exit(
            f"토큰 갱신 실패 (HTTP {e.code}): {e.read().decode()[:300]}\n"
            "refresh token이 무효해졌을 수 있습니다(동의 화면이 '테스트' 상태면 7일 만료). "
            "auth.py를 다시 실행하세요."
        )

    os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
    fd = os.open(CACHE_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(
            {
                "access_token": tok["access_token"],
                "expires_at": time.time() + tok.get("expires_in", 3600),
                "cred": fingerprint,
            },
            f,
        )
    return tok["access_token"]


# ------------------------------------------------------------------- API 호출


def api_call(
    path: str,
    params: dict | None = None,
    method: str = "GET",
    body: dict | None = None,
    _retry: bool = True,
) -> dict:
    url = f"{API}/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params, safe="'!:,()")
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": f"Bearer {access_token()}"}
    if data:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:600]

        # 스코프를 넓혀 재인증한 직후에는 이전 스코프로 발급된 access token이 캐시에 남아 있다
        # (만료까지 최대 1시간). 캐시를 버리고 한 번만 재시도한다.
        if _retry and e.code in (401, 403) and (
            "ACCESS_TOKEN_SCOPE_INSUFFICIENT" in detail or "UNAUTHENTICATED" in detail
        ):
            try:
                os.remove(CACHE_PATH)
            except OSError:
                pass
            return api_call(path, params, method, body, _retry=False)

        hint = ""
        if "ACCESS_TOKEN_SCOPE_INSUFFICIENT" in detail:
            hint = "\n힌트: 쓰기 스코프가 없습니다. `python3 -u auth.py --write`로 재인증하세요."
        elif e.code == 403:
            hint = "\n힌트: 시트가 인증 계정에 공유되지 않았거나 Sheets API가 비활성일 수 있습니다."
        sys.exit(f"API 실패 (HTTP {e.code}): {detail}{hint}")


# --------------------------------------------------------------------- 유틸


def parse_target(s: str) -> tuple[str, int | None]:
    """시트 ID 또는 URL에서 (spreadsheetId, gid)를 뽑는다."""
    m = re.search(r"/spreadsheets/d/([\w-]+)", s)
    sid = m.group(1) if m else s
    g = re.search(r"[#&?]gid=(\d+)", s)
    return sid, int(g.group(1)) if g else None


def hex_color(c: dict | None) -> str:
    if not c:
        return ""
    r, g, b = (round(c.get(k, 0) * 255) for k in ("red", "green", "blue"))
    if (r, g, b) == (255, 255, 255):
        return ""  # 기본 흰 배경은 노이즈라 생략
    return f"#{r:02x}{g:02x}{b:02x}"


def read_tsv(source: str | None) -> list[list[str]]:
    """TSV를 2차원 배열로 읽는다. source가 '-' 또는 None이면 표준입력."""
    if source in (None, "-"):
        text = sys.stdin.read()
    else:
        with open(source, encoding="utf-8") as f:
            text = f.read()
    rows = [line.split("\t") for line in text.splitlines()]
    if not rows:
        sys.exit("입력 데이터가 비어 있습니다.")
    return rows


def quote_range(rng: str) -> str:
    return urllib.parse.quote(rng, safe="")


def a1_sheet(title: str) -> str:
    """탭 제목을 A1 표기용으로 인용한다.

    공백·슬래시만 든 제목은 인용 없이도 API가 받아주지만, 숫자로 시작하거나
    `!`·`'`가 든 제목은 셀 참조로 오해될 수 있어 항상 인용한다.
    내부 작은따옴표는 두 개로 이스케이프한다.
    """
    return "'" + title.replace("'", "''") + "'"


def col_letter(index: int) -> str:
    """0-based 열 인덱스를 A1 열 문자로 변환한다 (0→A, 25→Z, 26→AA)."""
    out = ""
    i = index
    while True:
        out = chr(ord("A") + i % 26) + out
        i = i // 26 - 1
        if i < 0:
            return out


# ------------------------------------------------------------------ 읽기 명령


def cmd_tabs(args) -> None:
    sid, _ = parse_target(args.target)
    d = api_call(
        sid, {"fields": "properties(title),sheets(properties(sheetId,title,index,gridProperties))"}
    )
    out = [
        {
            "gid": s["properties"]["sheetId"],
            "index": s["properties"]["index"],
            "title": s["properties"]["title"],
            "rows": s["properties"].get("gridProperties", {}).get("rowCount"),
            "cols": s["properties"].get("gridProperties", {}).get("columnCount"),
        }
        for s in d.get("sheets", [])
    ]
    if args.json:
        print(
            json.dumps({"title": d["properties"]["title"], "tabs": out}, ensure_ascii=False, indent=2)
        )
        return
    print(f"문서: {d['properties']['title']}")
    print(f"{'idx':>3}  {'gid':>12}  {'행x열':>12}  탭 이름")
    for t in out:
        print(f"{t['index']:>3}  {t['gid']:>12}  {str(t['rows'])+'x'+str(t['cols']):>12}  {t['title']}")


def cmd_values(args) -> None:
    sid, _ = parse_target(args.target)
    d = api_call(f"{sid}/values/{quote_range(args.range)}")
    rows = d.get("values", [])
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return
    for row in rows:
        print("\t".join(str(c) for c in row))


def cmd_grid(args) -> None:
    sid, _ = parse_target(args.target)
    d = api_call(
        sid,
        {
            "ranges": args.range,
            "includeGridData": "true",
            # startRow·startColumn을 함께 받아야 범위가 A1이 아닐 때 실제 행·열을 알 수 있다.
            "fields": "sheets(properties(title,sheetId),data(startRow,startColumn,rowData(values("
            "formattedValue,effectiveFormat(backgroundColor)))))",
        },
    )
    result = []
    for sheet in d.get("sheets", []):
        title = sheet["properties"]["title"]
        for data in sheet.get("data", []):
            # 0이면 응답에서 생략되므로 기본값 0으로 받는다.
            row0 = data.get("startRow", 0)
            col0 = data.get("startColumn", 0)
            for r, row in enumerate(data.get("rowData", [])):
                sheet_row = row0 + r + 1  # 시트 화면과 같은 1-based 행 번호
                cells = [
                    {
                        "row": sheet_row,
                        "col": col_letter(col0 + c),
                        "c": col0 + c,
                        "v": cell.get("formattedValue", ""),
                        "bg": hex_color((cell.get("effectiveFormat") or {}).get("backgroundColor")),
                    }
                    for c, cell in enumerate(row.get("values", []))
                ]
                result.append({"sheet": title, "row": sheet_row, "cells": cells})
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return
    for line in result:
        print("\t".join(f"{c['v']}{'[' + c['bg'] + ']' if c['bg'] else ''}" for c in line["cells"]))


def cmd_dump(args) -> None:
    sid, url_gid = parse_target(args.target)
    gid = args.gid if args.gid is not None else url_gid
    meta = api_call(sid, {"fields": "sheets(properties(sheetId,title))"})
    tabs = [(s["properties"]["sheetId"], s["properties"]["title"]) for s in meta.get("sheets", [])]
    if gid is not None:
        tabs = [t for t in tabs if t[0] == gid]
        if not tabs:
            sys.exit(f"gid={gid} 탭을 찾을 수 없습니다.")
    for tab_gid, title in tabs:
        print(f"===== [{tab_gid}] {title} =====")
        d = api_call(f"{sid}/values/{quote_range(a1_sheet(title))}")
        for row in d.get("values", []):
            print("\t".join(str(c) for c in row))
        print()


# ------------------------------------------------------------------ 쓰기 명령


def cmd_set(args) -> None:
    sid, _ = parse_target(args.target)
    rows = read_tsv(args.tsv)
    d = api_call(
        f"{sid}/values/{quote_range(args.range)}",
        {"valueInputOption": "RAW" if args.raw else "USER_ENTERED"},
        method="PUT",
        body={"values": rows},
    )
    print(
        f"✅ 덮어씀: {d.get('updatedRange', args.range)} "
        f"({d.get('updatedRows', len(rows))}행 / {d.get('updatedCells', '?')}셀)"
    )


def cmd_append(args) -> None:
    sid, _ = parse_target(args.target)
    rows = read_tsv(args.tsv)
    d = api_call(
        f"{sid}/values/{quote_range(args.range)}:append",
        {
            "valueInputOption": "RAW" if args.raw else "USER_ENTERED",
            "insertDataOption": "INSERT_ROWS",
        },
        method="POST",
        body={"values": rows},
    )
    upd = d.get("updates", {})
    print(f"✅ 추가함: {upd.get('updatedRange', args.range)} ({upd.get('updatedRows', len(rows))}행)")


def cmd_clear(args) -> None:
    if not args.yes:
        sys.exit("삭제는 되돌리기 어렵습니다. 확인했다면 --yes 를 붙여 다시 실행하세요.")
    sid, _ = parse_target(args.target)
    d = api_call(f"{sid}/values/{quote_range(args.range)}:clear", method="POST", body={})
    print(f"✅ 값 삭제: {d.get('clearedRange', args.range)}")


# ---------------------------------------------------------------------- main


def main() -> None:
    # --json은 서브커맨드 앞뒤 어디에 와도 동작해야 한다.
    # 서브파서 쪽은 default=SUPPRESS로 둬야 플래그 없을 때 최상위 값을 덮어쓰지 않는다.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--json", action="store_true", default=argparse.SUPPRESS, help="JSON으로 출력"
    )

    p = argparse.ArgumentParser(description="Google Sheets 읽기·쓰기 CLI")
    p.add_argument("--json", action="store_true", default=False, help="JSON으로 출력")
    sub = p.add_subparsers(dest="cmd", required=True)

    t = sub.add_parser("tabs", help="탭 목록(gid·이름·크기)", parents=[common])
    t.add_argument("target")
    t.set_defaults(func=cmd_tabs)

    v = sub.add_parser("values", help="A1 범위의 값", parents=[common])
    v.add_argument("target")
    v.add_argument("range")
    v.set_defaults(func=cmd_values)

    g = sub.add_parser("grid", help="값 + 배경색", parents=[common])
    g.add_argument("target")
    g.add_argument("range")
    g.set_defaults(func=cmd_grid)

    d = sub.add_parser("dump", help="탭 전체를 TSV로", parents=[common])
    d.add_argument("target")
    d.add_argument("--gid", type=int, default=None)
    d.set_defaults(func=cmd_dump)

    s = sub.add_parser("set", help="범위를 덮어쓴다 (TSV 입력)", parents=[common])
    s.add_argument("target")
    s.add_argument("range")
    s.add_argument("--tsv", default="-", help="TSV 파일 경로 (기본: 표준입력)")
    s.add_argument("--raw", action="store_true", help="수식·날짜 해석 없이 문자열로 저장")
    s.set_defaults(func=cmd_set)

    a = sub.add_parser("append", help="표 끝에 행 추가 (TSV 입력)", parents=[common])
    a.add_argument("target")
    a.add_argument("range", help="탭 이름 또는 범위")
    a.add_argument("--tsv", default="-", help="TSV 파일 경로 (기본: 표준입력)")
    a.add_argument("--raw", action="store_true")
    a.set_defaults(func=cmd_append)

    c = sub.add_parser("clear", help="범위의 값 삭제", parents=[common])
    c.add_argument("target")
    c.add_argument("range")
    c.add_argument("--yes", action="store_true", help="확인 (없으면 거부)")
    c.set_defaults(func=cmd_clear)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
