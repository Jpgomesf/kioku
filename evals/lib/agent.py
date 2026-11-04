"""Shared pieces of Kioku's model harnesses: isolated storage, a stdio MCP
client, an OpenAI-compatible chat client, and the tool-calling agent loop.

Used by evals/behavior/run_openai.py and evals/answers/run.py. Those scripts
run with `python3 -I`, which leaves the script directory off sys.path, so they
add this directory explicitly before `import agent`. No packages are needed.

Nothing here prints environment values, request headers, or server stderr:
the env file holds service credentials.
"""

from __future__ import annotations

import json
import os
import re
import selectors
import shlex
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BINARY = ROOT / "target" / "release" / "kioku"
DEFAULT_DATABASE = "memory_harness_eval"
DEFAULT_COLLECTION = "local_memory_v1_harness_eval"
RUNS_DIR = ROOT / "evals" / "runs"

# What an MCP client adds the server's `instructions` to. Kept short and
# neutral so the server's own policy drives tool use.
NEUTRAL_SYSTEM = "You are a helpful coding assistant. Answer the user's request."

# Settings inherited from the caller's shell must never reach the server.
CONFIG_ENV = {
    "DATABASE_URL", "QDRANT_URL", "QDRANT_COLLECTION", "QDRANT_API_KEY",
    "EMBEDDING_PROVIDER", "EMBEDDING_URL", "EMBEDDING_MODEL", "EMBEDDING_DIM",
    "EMBEDDING_API_KEY", "ALLOW_REMOTE_EMBEDDINGS", "MEMORY_HALF_LIFE_DAYS",
    "MEMORY_LEGACY_THRESHOLD", "MEMORY_DEFAULT_DOMAIN", "MEMORY_NOTES_ROOT", "MEMORY_TOOLS",
    "MEMORY_TRACE_FILE", "MEMORY_TRACE_RUN", "MEMORY_BACKGROUND_UPKEEP", "KIOKU_ENV_FILE", "RUST_LOG",
}
# `--env-file` values override the process environment, so per-trial settings
# are removed from the derived file and passed as environment variables.
PER_RUN_ENV = {"MEMORY_TRACE_FILE", "MEMORY_TRACE_RUN", "MEMORY_TOOLS", "MEMORY_NOTES_ROOT", "KIOKU_ENV_FILE"}

DISPOSABLE = re.compile(r"^[a-z0-9_]{1,63}$")


class HarnessError(Exception):
    """A concise failure that never includes credentials or server payloads."""


class ChatError(Exception):
    """The chat endpoint failed or returned something unusable."""


# --------------------------------------------------------------------------
# Isolated storage
# --------------------------------------------------------------------------

def read_env(path: Path) -> dict[str, str]:
    """Read literal dotenv values; never execute shell text."""
    values: dict[str, str] = {}
    for number, original in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = original.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            raise HarnessError(f"env file line {number} is not KEY=value")
        key, raw = line.split("=", 1)
        key = key.strip()
        try:
            parts = shlex.split(raw, comments=True, posix=True)
        except ValueError:
            raise HarnessError(f"env file line {number} has invalid quoting") from None
        if len(parts) > 1:
            raise HarnessError(f"env file line {number} requires a quoted value")
        if key in values:
            raise HarnessError(f"env file defines {key} twice")
        values[key] = parts[0] if parts else ""
    return values


def _dotenv_value(value: str) -> str:
    # Single quotes are literal in dotenvy: no `$` expansion and no escapes.
    if "'" not in value and "\n" not in value:
        return "'" + value + "'"
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$").replace("\n", "\\n")
    return '"' + escaped + '"'


def write_private(path: Path, text: str) -> None:
    """Write a file readable only by its owner, replacing any previous one."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(text)


def is_disposable(name: str) -> bool:
    """The same rule `kioku eval` enforces for databases and collections it drops."""
    return bool(DISPOSABLE.match(name)) and ("eval" in name or "test" in name)


def derive_env(base: Path, out: Path, database: str, collection: str) -> Path:
    """Copy `base` to `out` (mode 0600) pointed at the isolated database and
    collection, without per-run settings and without background upkeep."""
    for label, name in (("database", database), ("collection", collection)):
        if not is_disposable(name):
            raise HarnessError(f"{label} {name!r} must be lowercase [a-z0-9_], at most 63 characters, and contain eval or test")
    values = read_env(base)
    url = values.get("DATABASE_URL", "")
    parts = urlsplit(url)
    if not parts.scheme.startswith("postgres") or not parts.netloc:
        raise HarnessError("the env file needs a postgres:// DATABASE_URL")
    values["DATABASE_URL"] = urlunsplit(parts._replace(path="/" + database))
    values["QDRANT_COLLECTION"] = collection
    for key in PER_RUN_ENV:
        values.pop(key, None)
    values["MEMORY_BACKGROUND_UPKEEP"] = "false"
    write_private(out, "".join(f"{key}={_dotenv_value(value)}\n" for key, value in values.items()))
    return out


def clean_environment(extra: dict[str, str] | None = None) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if key not in CONFIG_ENV}
    env["RUST_LOG"] = "error"
    env.update(extra or {})
    return env


def _safe_tail(stderr: str, lines: int = 6) -> str:
    """Last stderr lines, minus anything that could carry a connection string."""
    kept = [line for line in stderr.splitlines() if "://" not in line and "password" not in line.lower()]
    return "\n".join(kept[-lines:])


def run_kioku(arguments: list[str], *, timeout: float = 1800.0) -> str:
    """Run a kioku CLI command and return its stdout."""
    try:
        result = subprocess.run(arguments, capture_output=True, text=True, env=clean_environment(), timeout=timeout)
    except subprocess.TimeoutExpired:
        raise HarnessError(f"kioku {arguments[3] if len(arguments) > 3 else ''} timed out") from None
    if result.returncode != 0:
        command = " ".join(a for a in arguments[3:] if not a.startswith("/")) or "command"
        raise HarnessError(f"kioku {command} failed (exit {result.returncode}):\n{_safe_tail(result.stderr)}")
    return result.stdout


def reset_storage(binary: Path, base_env: Path, server_env: Path, out: Path, *, database: str, collection: str,
                  domain: str, extra_paths: tuple[Path, ...] = ()) -> None:
    """Recreate the isolated storage with the retrieval corpus (`kioku eval`
    drops, recreates, imports, and retires), then ingest `extra_paths`."""
    report = run_kioku([str(binary), "--env-file", str(base_env), "eval", "--database", database,
                        "--collection", collection, "--output", str(out / "retrieval-eval.json")])
    (out / "retrieval-eval.md").write_text(report, encoding="utf-8")
    for path in extra_paths:
        run_kioku([str(binary), "--env-file", str(server_env), "ingest", "--path", str(path), "--domain", domain])


def check_binary(binary: Path) -> Path:
    binary = binary.resolve()
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise HarnessError(f"{binary} is not an executable; build it with `cargo build --release --locked`")
    return binary


def new_run_dir(prefix: str, out: Path | None) -> Path:
    path = out or RUNS_DIR / f"{prefix}-{time.strftime('%Y%m%d-%H%M%S')}"
    path.mkdir(parents=True, exist_ok=True)
    os.chmod(path, 0o700)
    return path.resolve()


# --------------------------------------------------------------------------
# MCP over stdio
# --------------------------------------------------------------------------

class McpClient:
    """A minimal MCP stdio client for one `kioku serve` process."""

    def __init__(self, binary: Path, env_file: Path, *, tools: str = "core", trace_file: Path | None = None,
                 run: str | None = None, timeout: float = 120.0, client_name: str = "kioku-harness"):
        extra = {"MEMORY_TOOLS": tools}
        if trace_file is not None:
            extra["MEMORY_TRACE_FILE"] = str(trace_file)
        if run is not None:
            extra["MEMORY_TRACE_RUN"] = run
        self.process = subprocess.Popen(
            [str(binary), "--env-file", str(env_file), "serve"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=clean_environment(extra), bufsize=0,
        )
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ, "stdout")
        self.selector.register(self.process.stderr, selectors.EVENT_READ, "stderr")
        self.buffer = bytearray()
        self.stderr_tail = bytearray()  # kept for debugging in-process; never printed
        self.sequence = 0
        self.timeout = timeout
        self.client_name = client_name

    def send(self, message: dict) -> None:
        encoded = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
        try:
            self.process.stdin.write(encoded)
            self.process.stdin.flush()
        except (BrokenPipeError, OSError):
            raise HarnessError("the MCP server exited") from None

    def request(self, method: str, params: dict | None = None) -> dict:
        self.sequence += 1
        request_id = self.sequence
        message = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        self.send(message)
        deadline = time.monotonic() + self.timeout
        while True:
            while b"\n" in self.buffer:
                line, _, rest = self.buffer.partition(b"\n")
                self.buffer = bytearray(rest)
                if not line.strip():
                    continue
                try:
                    response = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    raise HarnessError("the MCP server wrote non-JSON output on stdout") from None
                if not isinstance(response, dict):
                    raise HarnessError("the MCP server sent an invalid JSON-RPC message")
                if "method" in response:
                    if "id" in response:  # a server-to-client request we do not implement
                        self.send({"jsonrpc": "2.0", "id": response["id"],
                                   "error": {"code": -32601, "message": "not supported by this client"}})
                    continue
                if response.get("id") != request_id:
                    continue
                if "error" in response:
                    error = response["error"] if isinstance(response["error"], dict) else {}
                    return {"_error": str(error.get("message", "JSON-RPC error"))[:500]}
                return response.get("result") or {}
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise HarnessError(f"MCP request {method} timed out after {self.timeout:.0f}s")
            events = self.selector.select(min(remaining, 1.0))
            for key, _ in events:
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    self.selector.unregister(key.fileobj)
                    if key.data == "stdout":
                        raise HarnessError("the MCP server closed stdout (did it fail to start?)")
                    continue
                if key.data == "stdout":
                    self.buffer.extend(data)
                    if len(self.buffer) > 4_000_000:
                        raise HarnessError("an MCP response exceeded 4 MB")
                else:
                    self.stderr_tail.extend(data)
                    del self.stderr_tail[:-32768]
            if not events and self.process.poll() is not None:
                raise HarnessError("the MCP server exited before answering")

    def initialize(self) -> dict:
        result = self.request("initialize", {
            "protocolVersion": "2025-11-25", "capabilities": {},
            "clientInfo": {"name": self.client_name, "version": "1.0.0"},
        })
        if "_error" in result:
            raise HarnessError("MCP initialize failed: " + result["_error"])
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        return result

    def list_tools(self) -> list[dict]:
        tools: list[dict] = []
        cursor = None
        while True:
            result = self.request("tools/list", {"cursor": cursor} if cursor else {})
            if "_error" in result:
                raise HarnessError("MCP tools/list failed: " + result["_error"])
            tools.extend(result.get("tools") or [])
            cursor = result.get("nextCursor")
            if not cursor:
                return tools

    def call_tool(self, name: str, arguments: dict) -> tuple[str, bool]:
        """Return the tool's text content and whether it is an error."""
        result = self.request("tools/call", {"name": name, "arguments": arguments})
        if "_error" in result:
            return result["_error"], True
        blocks = result.get("content") or []
        text = "\n".join(b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text")
        if not text and result.get("structuredContent") is not None:
            text = json.dumps(result["structuredContent"], ensure_ascii=False)
        return text, bool(result.get("isError", False))

    def close(self) -> None:
        if self.process.stdin:
            try:
                self.process.stdin.close()
            except (BrokenPipeError, OSError):
                pass
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)
        self.selector.close()
        for stream in (self.process.stdout, self.process.stderr):
            if stream:
                stream.close()


def openai_tools(mcp_tools: list[dict]) -> list[dict]:
    """MCP tool definitions in the OpenAI `tools` (function) format."""
    return [{
        "type": "function",
        "function": {
            "name": tool["name"],
            "description": tool.get("description", ""),
            "parameters": tool.get("inputSchema") or {"type": "object", "properties": {}},
        },
    } for tool in mcp_tools]


# --------------------------------------------------------------------------
# OpenAI-compatible chat completions
# --------------------------------------------------------------------------

def _post_json(url: str, body: dict | None, api_key: str | None, timeout: float) -> dict:
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=data, method="GET" if body is None else "POST")
    request.add_header("Content-Type", "application/json")
    if api_key:
        request.add_header("Authorization", "Bearer " + api_key)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read()
    except urllib.error.HTTPError as error:
        detail = error.read()[:400].decode("utf-8", "replace")
        raise ChatError(f"HTTP {error.code} from {url}: {detail}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise ChatError(f"cannot reach {url}: {getattr(error, 'reason', error)}") from None
    try:
        value = json.loads(payload)
    except ValueError:
        raise ChatError(f"{url} returned non-JSON") from None
    if not isinstance(value, dict):
        raise ChatError(f"{url} returned JSON that is not an object")
    return value


def list_models(base_url: str, api_key: str | None, timeout: float = 10.0) -> list[str]:
    data = _post_json(base_url.rstrip("/") + "/models", None, api_key, timeout)
    return [str(m.get("id")) for m in data.get("data") or [] if isinstance(m, dict) and m.get("id")]


def resolve_model(base_url: str, model: str | None, api_key: str | None) -> str:
    """Use `model`, or the endpoint's only model."""
    if model:
        return model
    models = list_models(base_url, api_key)
    if len(models) != 1:
        raise HarnessError(f"pass --model: the endpoint lists {models or 'no models'}")
    return models[0]


def api_key_from(env_name: str | None) -> str | None:
    if not env_name:
        return None
    value = os.environ.get(env_name)
    if not value:
        raise HarnessError(f"environment variable {env_name} is not set")
    return value


class ChatClient:
    def __init__(self, base_url: str, model: str, api_key: str | None = None, timeout: float = 300.0):
        self.url = base_url.rstrip("/") + "/chat/completions"
        self.model = model
        self.api_key = api_key
        self.timeout = timeout

    def complete(self, messages: list[dict], tools: list[dict] | None = None,
                 temperature: float | None = None) -> dict:
        body: dict = {"model": self.model, "messages": messages, "stream": False}
        if tools:
            body["tools"] = tools
        if temperature is not None:
            body["temperature"] = temperature
        response = _post_json(self.url, body, self.api_key, self.timeout)
        choices = response.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            raise ChatError("the response has no choices")
        return response


# --------------------------------------------------------------------------
# The agent loop
# --------------------------------------------------------------------------

THINK_BLOCK = re.compile(r"<think>.*?</think>", re.S | re.I)
# Tool calls written into the text instead of the tool-calls field.
TEXT_TOOL_CALL = re.compile(r"<tool_call>|<function=|\"name\"\s*:\s*\"memory_\w+\"", re.I)


def strip_thinking(text: str | None) -> str:
    """Drop `<think>` blocks some reasoning models leave in the content."""
    text = THINK_BLOCK.sub("", text or "")
    if "</think>" in text.lower():  # the template opened the block in the prompt
        text = re.split(r"</think>", text, flags=re.I)[-1]
    return text.strip()


def message_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):  # content parts
        return "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return ""


def parse_arguments(raw) -> tuple[dict | None, str | None]:
    """Tool-call arguments as a dict, or None and the reason they are invalid."""
    if isinstance(raw, dict):
        return raw, None
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return {}, None
    if not isinstance(raw, str):
        return None, f"arguments must be a JSON string, got {type(raw).__name__}"
    try:
        value = json.loads(raw)
    except ValueError as error:
        return None, f"arguments are not valid JSON ({error})"
    if not isinstance(value, dict):
        return None, "arguments must be a JSON object"
    return value, None


def _add_usage(total: dict, usage) -> None:
    if not isinstance(usage, dict):
        return
    for field in ("prompt_tokens", "completion_tokens"):
        if isinstance(usage.get(field), int):
            total[field] = (total[field] or 0) + usage[field]


def run_agent(chat: ChatClient, system: str, user: str, *, mcp: McpClient | None = None,
              tools: list[dict] | None = None, max_turns: int = 15,
              temperature: float | None = None) -> dict:
    """Chat until the model answers without tool calls or `max_turns` model
    calls are spent. Malformed tool calls are answered with an error and
    recorded in `invalid_calls`; they are never sent to the server."""
    messages: list[dict] = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    names = {t["function"]["name"] for t in tools or []}
    record: dict = {
        "answer": "", "raw_answer": "", "turns": 0, "tool_calls": [], "invalid_calls": [],
        "usage": {"prompt_tokens": None, "completion_tokens": None},
        "stop_reason": None, "error": None,
    }
    started = time.monotonic()
    generated_ids = 0
    while True:
        if record["turns"] >= max_turns:
            record["stop_reason"] = "max_turns"
            break
        try:
            response = chat.complete(messages, tools=tools or None, temperature=temperature)
        except ChatError as error:
            record["stop_reason"], record["error"] = "api_error", str(error)[:500]
            break
        record["turns"] += 1
        turn = record["turns"]
        _add_usage(record["usage"], response.get("usage"))
        choice = response["choices"][0]
        message = choice.get("message") or {}
        content = message_text(message.get("content"))
        calls = message.get("tool_calls") or []
        record["raw_answer"] = content
        if not isinstance(calls, list) or not calls:
            if tools and TEXT_TOOL_CALL.search(strip_thinking(content)):
                record["invalid_calls"].append({"turn": turn, "name": None, "problem": "tool call written as text",
                                                "raw": content[:500]})
            messages.append({"role": "assistant", "content": content})
            record["answer"] = strip_thinking(content)
            record["stop_reason"] = choice.get("finish_reason") or "stop"
            break
        assistant = {"role": "assistant", "content": message.get("content"), "tool_calls": []}
        replies = []
        for call in calls:
            call = call if isinstance(call, dict) else {}
            function = call.get("function") if isinstance(call.get("function"), dict) else {}
            name = function.get("name")
            raw = function.get("arguments")
            call_id = call.get("id")
            if not call_id:
                generated_ids += 1
                call_id = f"call_{generated_ids}"
            assistant["tool_calls"].append({"id": call_id, "type": "function", "function": {
                "name": name or "", "arguments": raw if isinstance(raw, str) else json.dumps(raw)}})
            arguments, problem = parse_arguments(raw)
            if not name or name not in names:
                problem = f"unknown tool {name!r}; available: {', '.join(sorted(names)) or 'none'}"
            if problem or mcp is None:
                problem = problem or "no tools are available"
                record["invalid_calls"].append({"turn": turn, "name": name, "problem": problem,
                                                "raw": raw if isinstance(raw, str) else repr(raw)[:500]})
                replies.append({"role": "tool", "tool_call_id": call_id,
                                "content": f"invalid tool call: {problem}. Call a listed tool with a JSON object of arguments."})
                continue
            try:
                text, is_error = mcp.call_tool(name, arguments)
            except HarnessError as error:
                record["stop_reason"], record["error"] = "mcp_error", str(error)
                record["agent_s"] = round(time.monotonic() - started, 3)
                record["messages"] = messages + [assistant] + replies
                return record
            record["tool_calls"].append({"turn": turn, "name": name, "arguments": arguments,
                                         "is_error": is_error, "result": text})
            replies.append({"role": "tool", "tool_call_id": call_id, "content": text})
        messages.append(assistant)
        messages.extend(replies)
    # After max_turns or an API error, `answer` stays empty: the last content
    # (kept in raw_answer) came with tool calls and is not a final answer.
    record["agent_s"] = round(time.monotonic() - started, 3)
    record["messages"] = messages
    return record


def run_mcp_trial(chat: ChatClient, binary: Path, env_file: Path, user: str, *, tools_profile: str = "core",
                  trace_file: Path | None = None, run: str | None = None, timeout: float = 300.0,
                  max_turns: int = 15, temperature: float | None = None, use_tools: bool = True) -> dict:
    """One trial: a fresh `kioku serve`, the server's instructions appended to
    the neutral system prompt (what MCP clients do), and the agent loop. With
    `use_tools=False` no server runs and the model gets the neutral prompt only."""
    started = time.monotonic()
    if not use_tools:
        record = run_agent(chat, NEUTRAL_SYSTEM, user, max_turns=max_turns, temperature=temperature)
        record.update(wall_s=round(time.monotonic() - started, 3), server_tools=[])
        return record
    mcp = McpClient(binary, env_file, tools=tools_profile, trace_file=trace_file, run=run,
                    timeout=timeout, client_name="kioku-openai-harness")
    try:
        try:
            initialized = mcp.initialize()
            mcp_tools = mcp.list_tools()
        except HarnessError as error:
            return {"answer": "", "raw_answer": "", "turns": 0, "tool_calls": [], "invalid_calls": [],
                    "usage": {"prompt_tokens": None, "completion_tokens": None}, "stop_reason": "mcp_error",
                    "error": str(error), "messages": [], "server_tools": [],
                    "wall_s": round(time.monotonic() - started, 3), "agent_s": 0.0}
        instructions = str(initialized.get("instructions") or "").strip()
        system = NEUTRAL_SYSTEM + ("\n\n" + instructions if instructions else "")
        record = run_agent(chat, system, user, mcp=mcp, tools=openai_tools(mcp_tools),
                           max_turns=max_turns, temperature=temperature)
        record["server_tools"] = [t["name"] for t in mcp_tools]
    finally:
        mcp.close()
    record["wall_s"] = round(time.monotonic() - started, 3)
    return record


class ApiErrorStreak:
    """Stop a run after `limit` trials in a row fail at the chat endpoint
    (it is down, the key is wrong, or the model is not loaded)."""

    def __init__(self, limit: int = 3):
        self.limit = limit
        self.count = 0

    def tripped(self, record: dict) -> bool:
        self.count = self.count + 1 if record.get("stop_reason") == "api_error" else 0
        return self.count >= self.limit


def trial_metrics(record: dict) -> dict:
    """The per-trial numbers both harnesses report."""
    return {
        "turns": record["turns"],
        "tool_calls": len(record["tool_calls"]),
        "invalid_calls": len(record["invalid_calls"]),
        "tool_errors": sum(1 for c in record["tool_calls"] if c["is_error"]),
        "prompt_tokens": record["usage"]["prompt_tokens"],
        "completion_tokens": record["usage"]["completion_tokens"],
        "wall_s": record["wall_s"],
        "stop_reason": record["stop_reason"],
        "error": record["error"],
    }
