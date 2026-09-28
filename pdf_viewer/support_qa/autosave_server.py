#!/usr/bin/env python3
"""Small draft autosave service for the Luotu web app.

Stores JSON-only draft states. It does not receive or store PDF files.
"""

from __future__ import annotations

import json
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


HOST = "0.0.0.0"
PORT = 8789
BASE_DIR = Path(__file__).resolve().parent
DRAFT_DIR = BASE_DIR / "autosave_drafts"
MAX_DRAFTS_PER_FILE = 5
MAX_BODY_BYTES = 20 * 1024 * 1024


def safe_name(value: str) -> str:
    value = value or "unknown"
    return re.sub(r"[^a-zA-Z0-9._-]+", "_", value)[:180]


def json_response(handler: BaseHTTPRequestHandler, status: int, data: dict) -> None:
    body = json.dumps(data, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.end_headers()
    handler.wfile.write(body)


class AutosaveHandler(BaseHTTPRequestHandler):
    server_version = "LuotuAutosave/1.0"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {self.address_string()} {fmt % args}")

    def do_OPTIONS(self) -> None:
        json_response(self, 200, {"ok": True})

    def do_GET(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/health":
            json_response(self, 200, {
                "ok": True,
                "ready": True,
                "service": "luotu-autosave",
                "draft_dir": str(DRAFT_DIR),
                "max_drafts_per_file": MAX_DRAFTS_PER_FILE,
            })
            return

        if parsed.path == "/api/autosave/latest":
            params = parse_qs(parsed.query)
            draft_key = params.get("draftKey", [""])[0]
            latest = self.get_latest_draft(draft_key)
            if not latest:
                json_response(self, 404, {"ok": False, "error": "draft_not_found"})
                return

            json_response(self, 200, {"ok": True, "draft": latest})
            return

        json_response(self, 404, {"ok": False, "error": "not_found"})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path != "/api/autosave/save":
            json_response(self, 404, {"ok": False, "error": "not_found"})
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0 or length > MAX_BODY_BYTES:
            json_response(self, 413, {"ok": False, "error": "invalid_body_size"})
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as exc:
            json_response(self, 400, {"ok": False, "error": f"invalid_json: {exc}"})
            return

        draft_key = payload.get("draftKey")
        if not draft_key:
            json_response(self, 400, {"ok": False, "error": "missing_draft_key"})
            return

        saved = self.save_draft(draft_key, payload)
        json_response(self, 200, {
            "ok": True,
            "draftKey": draft_key,
            "savedAt": payload.get("savedAt"),
            "path": str(saved),
        })

    def draft_folder(self, draft_key: str) -> Path:
        return DRAFT_DIR / safe_name(draft_key)

    def get_latest_draft(self, draft_key: str) -> dict | None:
        if not draft_key:
            return None

        folder = self.draft_folder(draft_key)
        if not folder.exists():
            return None

        files = sorted(folder.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True)
        if not files:
            return None

        try:
            return json.loads(files[0].read_text(encoding="utf-8"))
        except Exception as exc:
            return {"error": f"read_failed: {exc}"}

    def save_draft(self, draft_key: str, payload: dict) -> Path:
        folder = self.draft_folder(draft_key)
        folder.mkdir(parents=True, exist_ok=True)

        timestamp = time.strftime("%Y%m%d_%H%M%S")
        filename = f"{timestamp}_{int(time.time() * 1000) % 1000:03d}.json"
        path = folder / filename
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

        files = sorted(folder.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True)
        for old_file in files[MAX_DRAFTS_PER_FILE:]:
            try:
                old_file.unlink()
            except OSError:
                pass

        return path


def main() -> None:
    DRAFT_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), AutosaveHandler)
    print(f"Luotu autosave service listening on http://{HOST}:{PORT}")
    print(f"Draft directory: {DRAFT_DIR}")
    server.serve_forever()


if __name__ == "__main__":
    main()
