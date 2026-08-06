#!/usr/bin/env python3
"""Google Sheets용 refresh token 발급 (최초 1회). 자세한 절차는 SETUP.md 참조.

왜 이 스크립트가 필요한가: Claude Code/Cursor의 MCP OAuth 플로우는 Google 전용
`access_type=offline`을 보내지 않아 refresh token을 받지 못한다(access token 1시간 만료 후
갱신 불가 → 매시간 재인증). 여기서는 그것을 명시해 refresh token을 확보한다.

사용법:
  GSHEETS_CLIENT_ID=... GSHEETS_CLIENT_SECRET=... python3 -u auth.py          # 읽기 전용
  GSHEETS_CLIENT_ID=... GSHEETS_CLIENT_SECRET=... python3 -u auth.py --write  # 읽기+쓰기

한 번 실행하면 클라이언트 자격증명도 저장되므로 이후 환경변수 없이 재실행할 수 있다.
자격증명은 macOS 키체인(또는 그 외 OS에서는 ~/.config/gsheets/credentials.json, 권한 600)에만
저장되며 저장소에 남는 값은 없다.
"""

import argparse
import base64
import hashlib
import http.server
import json
import os
import platform
import secrets
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

KEYCHAIN_SERVICE = "gsheets-oauth"
CONFIG_PATH = os.path.expanduser("~/.config/gsheets/credentials.json")
CACHE_PATH = os.path.expanduser("~/.cache/gsheets/token.json")  # gsheets.py와 동일 경로

READ_SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
]
WRITE_SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",  # 읽기 포함
    "https://www.googleapis.com/auth/drive.readonly",
]

IS_MAC = platform.system() == "Darwin"


# ------------------------------------------------------------- 자격증명 저장소


def _keychain_get(account: str) -> str | None:
    if not IS_MAC:
        return None
    r = subprocess.run(
        ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
        capture_output=True,
        text=True,
    )
    return r.stdout.strip() if r.returncode == 0 else None


def _file_read() -> dict:
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _file_write(patch: dict) -> None:
    data = _file_read()
    data.update(patch)
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    fd = os.open(CONFIG_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def store_client(client: dict) -> None:
    if IS_MAC:
        subprocess.run(
            [
                "security", "add-generic-password",
                "-s", KEYCHAIN_SERVICE, "-a", "client",
                "-w", json.dumps(client), "-U",
            ],
            check=True,
            capture_output=True,
        )
    else:
        _file_write(client)


def store_refresh_token(token: str) -> None:
    if IS_MAC:
        subprocess.run(
            [
                "security", "add-generic-password",
                "-s", KEYCHAIN_SERVICE, "-a", "refresh_token",
                "-w", token, "-U",
            ],
            check=True,
            capture_output=True,
        )
    else:
        _file_write({"refresh_token": token})


def load_client() -> dict:
    """저장된 클라이언트 자격증명을 쓰고, 없으면 환경변수에서 받아 저장한다."""
    raw = _keychain_get("client")
    if raw:
        return json.loads(raw)

    stored = _file_read()
    if stored.get("client_id") and stored.get("client_secret"):
        return {"client_id": stored["client_id"], "client_secret": stored["client_secret"]}

    cid = os.environ.get("GSHEETS_CLIENT_ID")
    sec = os.environ.get("GSHEETS_CLIENT_SECRET")
    if not (cid and sec):
        sys.exit(
            "OAuth 클라이언트 자격증명이 없습니다.\n"
            "SETUP.md의 1~3단계로 클라이언트를 발급한 뒤 다음처럼 실행하세요:\n"
            "  GSHEETS_CLIENT_ID=... GSHEETS_CLIENT_SECRET=... python3 -u auth.py"
        )
    client = {"client_id": cid, "client_secret": sec}
    store_client(client)
    return client


# ------------------------------------------------------------------ 콜백 서버


class CallbackHandler(http.server.BaseHTTPRequestHandler):
    result: dict = {}

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/callback":
            self.send_error(404)
            return
        params = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}

        # code·error 없는 요청(브라우저 리다이렉트 전 사전 접속, 헬스체크 등)에
        # 서버를 내려버리면 정작 실제 콜백을 받지 못한다 — 무시하고 계속 대기한다.
        if "code" not in params and "error" not in params:
            self.send_error(400, "missing code or error")
            return

        CallbackHandler.result = params
        err = params.get("error")
        body = f"인증 실패: {err}" if err else "인증이 완료되었습니다. 터미널로 돌아가세요."
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(f"<html><body><h3>{body}</h3></body></html>".encode())
        threading.Thread(target=self.server.shutdown, daemon=True).start()

    def log_message(self, *args):  # 콘솔 잡음 억제
        pass


# ---------------------------------------------------------------------- main


def main() -> None:
    ap = argparse.ArgumentParser(description="Google Sheets refresh token 발급")
    ap.add_argument("--write", action="store_true", help="쓰기 스코프까지 요청 (기본: 읽기 전용)")
    ap.add_argument(
        "--port",
        type=int,
        default=8080,
        help="콜백 포트. OAuth 클라이언트에 등록한 리디렉션 URI와 일치해야 한다 (기본 8080)",
    )
    args = ap.parse_args()

    scopes = WRITE_SCOPES if args.write else READ_SCOPES
    redirect_uri = f"http://localhost:{args.port}/callback"
    client = load_client()

    verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).decode().rstrip("=")
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    )
    state = secrets.token_urlsafe(16)

    auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(
        {
            "client_id": client["client_id"],
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": " ".join(scopes),
            "access_type": "offline",  # refresh token 발급의 핵심
            "prompt": "consent",  # 이미 동의한 계정에도 refresh token 재발급
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )

    print(f"모드: {'읽기+쓰기' if args.write else '읽기 전용'}")
    print("브라우저에서 Google 인증을 완료하세요. 시트가 공유된 계정을 선택해야 합니다.\n")
    print(auth_url, "\n")

    try:
        server = http.server.HTTPServer(("localhost", args.port), CallbackHandler)
    except OSError as e:
        sys.exit(f"포트 {args.port} 바인딩 실패: {e}\n다른 포트를 쓰려면 --port 로 지정하고 리디렉션 URI도 함께 등록하세요.")

    webbrowser.open(auth_url)
    server.serve_forever()  # 콜백 수신 시 종료
    server.server_close()

    res = CallbackHandler.result
    if "error" in res:
        sys.exit(f"인증 실패: {res['error']}")
    if res.get("state") != state:
        sys.exit("state 불일치 — 중단합니다.")
    if "code" not in res:
        sys.exit("콜백에 authorization code가 없습니다. 인증을 다시 시도하세요.")

    payload = urllib.parse.urlencode(
        {
            "code": res["code"],
            "client_id": client["client_id"],
            "client_secret": client["client_secret"],
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
            "code_verifier": verifier,
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
        sys.exit(f"토큰 교환 실패 (HTTP {e.code}): {e.read().decode()[:500]}")

    refresh = tok.get("refresh_token")
    if not refresh:
        sys.exit(
            f"refresh_token이 발급되지 않았습니다. 응답 키: {sorted(tok)}\n"
            "Google 계정 > 보안 > 서드파티 액세스에서 이 앱의 기존 권한을 제거하고 재시도하세요."
        )

    store_refresh_token(refresh)

    # 스코프가 바뀐 경우 캐시된 access token이 이전 스코프로 남아 있으면
    # 만료(최대 1시간)까지 ACCESS_TOKEN_SCOPE_INSUFFICIENT가 난다 — 캐시를 버린다.
    try:
        os.remove(CACHE_PATH)
        print("  (이전 access token 캐시를 삭제했습니다)")
    except OSError:
        pass

    where = "macOS 키체인" if IS_MAC else CONFIG_PATH
    print(f"✅ refresh token을 저장했습니다 ({where}). 이후 재인증이 필요 없습니다.")
    print(f"   허용 스코프: {tok.get('scope', '(응답에 없음)')}")
    print("\n확인:  python3 gsheets.py tabs \"<시트 URL>\"")


if __name__ == "__main__":
    main()
