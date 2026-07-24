#!/usr/bin/env python3
"""Minimal OpenAI-compatible mock upstream for E2E tests.

Answers every POST */chat/completions with a fixed completion and a fixed
usage block, so the router can be exercised without a real provider key.
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def _send(self, payload: dict, status: int = 200) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            body = {}
        model = body.get("model", "mock")
        # "SIMPLE" doubles as a plausible classifier verdict; if the
        # classifier can't parse it, fail_open routes to strong, which is
        # fine for the test.
        self._send(
            {
                "id": "chatcmpl-mock",
                "object": "chat.completion",
                "created": 0,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "SIMPLE"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            }
        )

    def do_GET(self) -> None:
        if self.path.endswith("/models"):
            self._send({"object": "list", "data": []})
        else:
            self._send({"ok": True})

    def log_message(self, fmt: str, *args) -> None:
        print(f"mock: {self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9999
    print(f"mock LLM listening on 0.0.0.0:{port}", flush=True)
    HTTPServer(("0.0.0.0", port), Handler).serve_forever()
