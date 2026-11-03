#!/usr/bin/env python3
"""Deterministic stand-in for an embedding service, used by CI.

Serves Ollama's POST /api/embed and the OpenAI-compatible POST /embeddings
(also under /v1). Vectors are signed feature hashes of lowercase word tokens,
L2-normalized, so texts that share words get similar vectors. That keeps
integration tests meaningful without downloading a model. Not for measuring
retrieval quality: use `kioku eval` with a real model for that.

Usage: python3 tests/fake_embedder.py --port 18080 --dim 256
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def embed(text: str, dim: int) -> list[float]:
    vector = [0.0] * dim
    for token in re.findall(r"\w+", text.lower()):
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        index = int.from_bytes(digest[:4], "little") % dim
        vector[index] += 1.0 if digest[4] & 1 else -1.0
    norm = math.sqrt(sum(x * x for x in vector))
    if norm == 0.0:
        vector[0], norm = 1.0, 1.0
    return [x / norm for x in vector]


def make_handler(dim: int) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 (http.server naming)
            length = int(self.headers.get("Content-Length", "0"))
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                self.reply(400, {"error": "invalid JSON"})
                return
            inputs = body.get("input", "")
            texts = inputs if isinstance(inputs, list) else [inputs]
            if not all(isinstance(t, str) for t in texts):
                self.reply(400, {"error": "input must be a string or a list of strings"})
                return
            vectors = [embed(t, dim) for t in texts]
            model = body.get("model", "fake")
            if self.path.rstrip("/") == "/api/embed":
                self.reply(200, {"model": model, "embeddings": vectors})
            elif self.path.rstrip("/") in ("/embeddings", "/v1/embeddings"):
                data = [{"object": "embedding", "index": i, "embedding": v} for i, v in enumerate(vectors)]
                self.reply(200, {"object": "list", "model": model, "data": data})
            else:
                self.reply(404, {"error": f"unknown path {self.path}"})

        def reply(self, status: int, payload: dict) -> None:
            data = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            pass

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18080)
    parser.add_argument("--dim", type=int, default=256)
    args = parser.parse_args()
    ThreadingHTTPServer((args.host, args.port), make_handler(args.dim)).serve_forever()


if __name__ == "__main__":
    main()
