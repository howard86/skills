#!/usr/bin/env python3
"""Delegate ONE task to a local kiro-cli instance over ACP (Agent Client Protocol).

Spawns `kiro-cli acp`, runs the JSON-RPC 2.0 handshake over stdio, opens a session
rooted at --cwd, sends a single prompt, streams Kiro's work, and prints the final
assistant text. Pure stdlib — no dependencies.

Exit code: 0 when the turn ends with stopReason "end_turn"; non-zero otherwise
(max_tokens / cancelled / refusal / transport error / timeout).

Examples:
  kiro-acp.py "Add a --json flag to scripts/foo.py and update its --help"
  echo "Explain src/auth and list the risky bits" | kiro-acp.py --cwd ../api
  kiro-acp.py --json --timeout 3600 "Refactor the parser; keep tests green" > out.json

See ../REFERENCE.md for the verified wire protocol and troubleshooting.
"""
import argparse
import json
import os
import subprocess
import sys
import threading

PROTOCOL_VERSION = 1


def eprint(*a):
    print(*a, file=sys.stderr, flush=True)


# Preferred models, best first. With no explicit --model we force the first of
# these that kiro offers; if none are available we drop out rather than fall
# back to kiro's task-routed "auto".
PREFERRED_MODELS = ("claude-opus-4.7", "claude-opus-4.6")


def resolve_preferred_model():
    """Best available id from PREFERRED_MODELS, or None to drop out."""
    try:
        out = subprocess.run(
            ["kiro-cli", "chat", "--list-models", "--format", "json"],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as e:
        eprint(f"error: could not query kiro models: {e}")
        return None
    if out.returncode != 0:
        eprint(f"error: `kiro-cli chat --list-models` failed: {out.stderr.strip()[:300]}")
        return None
    try:
        offered = {m.get("model_id") for m in json.loads(out.stdout).get("models", [])}
    except (json.JSONDecodeError, AttributeError):
        eprint("error: could not parse kiro model list")
        return None
    for mid in PREFERRED_MODELS:
        if mid in offered:
            return mid
    eprint(f"error: none of {list(PREFERRED_MODELS)} available "
           f"(offered: {sorted(m for m in offered if m)}); dropping out")
    return None


class KiroACP:
    def __init__(self, args):
        self.args = args
        self.proc = None
        self._next_id = 0
        self._wlock = threading.Lock()
        self._plock = threading.Lock()
        self._pending = {}          # id -> {"event": Event, "msg": dict}
        self._chunks = []           # assembled assistant text
        self._meta = {}             # last _kiro.dev/metadata payload
        self.session_id = None
        self.stop_reason = None
        self.stream = not args.json  # live-print chunks unless emitting JSON

    # ---- transport ----------------------------------------------------------
    def _send(self, obj):
        line = json.dumps(obj)
        with self._wlock:
            self.proc.stdin.write(line + "\n")
            self.proc.stdin.flush()

    def _request(self, method, params, timeout):
        with self._plock:
            rid = self._next_id
            self._next_id += 1
            ev = threading.Event()
            self._pending[rid] = {"event": ev, "msg": None}
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        if not ev.wait(timeout):
            raise TimeoutError(f"no response to {method!r} within {timeout}s")
        msg = self._pending.pop(rid)["msg"]
        if "error" in msg:
            raise RuntimeError(f"{method} failed: {json.dumps(msg['error'])}")
        return msg.get("result", {})

    # ---- reader thread ------------------------------------------------------
    def _reader(self):
        for raw in self.proc.stdout:
            raw = raw.strip()
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue  # kiro occasionally prints non-JSON banner lines
            self._dispatch(msg)

    def _dispatch(self, msg):
        method = msg.get("method")
        mid = msg.get("id")
        if method and mid is not None:
            self._handle_server_request(mid, method, msg.get("params", {}))
        elif method:
            self._handle_notification(method, msg.get("params", {}))
        elif mid is not None:
            with self._plock:
                slot = self._pending.get(mid)
            if slot:
                slot["msg"] = msg
                slot["event"].set()

    def _handle_server_request(self, mid, method, params):
        # Defensive: even with --trust-all-tools, auto-approve any permission ask.
        if method == "session/request_permission":
            options = params.get("options", [])
            chosen = next((o["id"] for o in options if "allow" in o.get("id", "")), None)
            if chosen is None and options:
                chosen = options[0]["id"]
            self._send({"jsonrpc": "2.0", "id": mid,
                        "result": {"outcome": {"type": "selected", "optionId": chosen}}})
        else:
            # A request we didn't advertise capabilities for: reject cleanly.
            self._send({"jsonrpc": "2.0", "id": mid,
                        "error": {"code": -32601, "message": f"unhandled: {method}"}})

    def _handle_notification(self, method, params):
        if method == "session/update":
            self._handle_update(params.get("update", {}))
        elif method == "_kiro.dev/metadata":
            self._meta = params

    def _handle_update(self, upd):
        kind = upd.get("sessionUpdate")
        if kind == "agent_message_chunk":
            text = (upd.get("content") or {}).get("text", "")
            self._chunks.append(text)
            if self.stream:
                sys.stdout.write(text)
                sys.stdout.flush()
        elif kind == "tool_call" and not self.args.quiet:
            raw = upd.get("rawInput") or {}
            name = upd.get("name") or upd.get("title") or raw.get("command") or "?"
            eprint(f"  · tool {name} {json.dumps(raw)[:160]}")
        elif kind == "tool_call_update" and not self.args.quiet:
            status = upd.get("status")
            if status in ("failed", "completed"):
                eprint(f"  · tool {upd.get('toolCallId', '')} -> {status}")
        elif kind == "agent_thought_chunk" and self.args.verbose:
            eprint("  ~ " + (upd.get("content") or {}).get("text", "")[:200])

    # ---- lifecycle ----------------------------------------------------------
    def run(self, prompt):
        cmd = ["kiro-cli", "acp"]
        if not self.args.no_trust:
            cmd.append("--trust-all-tools")
        if self.args.trust_tools:
            cmd += ["--trust-tools", self.args.trust_tools]
        if self.args.agent:
            cmd += ["--agent", self.args.agent]
        if self.args.model:
            cmd += ["--model", self.args.model]

        self.proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1,
        )
        threading.Thread(target=self._reader, daemon=True).start()

        self._request("initialize", {
            "protocolVersion": PROTOCOL_VERSION,
            "clientCapabilities": {},      # we run no fs/terminal — Kiro uses its own tools
            "clientInfo": {"name": "kiro-acp.py", "version": "1.0.0"},
        }, timeout=30)

        cwd = os.path.abspath(self.args.cwd)
        if self.args.resume:
            self._request("session/load", {
                "sessionId": self.args.resume, "cwd": cwd, "mcpServers": []}, timeout=60)
            self.session_id = self.args.resume
        else:
            res = self._request("session/new", {"cwd": cwd, "mcpServers": []}, timeout=60)
            self.session_id = res.get("sessionId")

        eprint(f"→ kiro session {self.session_id} in {cwd}")

        res = self._request("session/prompt", {
            "sessionId": self.session_id,
            "prompt": [{"type": "text", "text": prompt}],
        }, timeout=self.args.timeout)
        self.stop_reason = res.get("stopReason")

        if self.stream:
            sys.stdout.write("\n")
            sys.stdout.flush()
        return self.session_id

    def summary_to_stderr(self):
        bits = [f"stopReason={self.stop_reason}"]
        if self._meta.get("turnDurationMs") is not None:
            bits.append(f"{self._meta['turnDurationMs'] / 1000:.1f}s")
        for m in self._meta.get("meteringUsage", []):
            bits.append(f"{m.get('value', 0):.4f} {m.get('unitPlural', 'units')}")
        if self._meta.get("contextUsagePercentage") is not None:
            bits.append(f"ctx {self._meta['contextUsagePercentage']:.1f}%")
        eprint("✓ " + "  ".join(bits))

    def close(self):
        if self.proc and self.proc.poll() is None:
            try:
                if self.session_id:
                    self._send({"jsonrpc": "2.0", "method": "session/cancel",
                                "params": {"sessionId": self.session_id}})
            except Exception:
                pass
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def parse_args():
    p = argparse.ArgumentParser(description="Delegate one task to local kiro-cli over ACP.")
    p.add_argument("prompt", nargs="?", help="Task for Kiro. If omitted, read from stdin.")
    p.add_argument("--cwd", default=".", help="Working directory Kiro operates in (default: cwd).")
    p.add_argument("--agent", help="kiro-cli agent name to start the session with.")
    p.add_argument("--model", help="Model id to use. Omit to force the best available of "
                                    "claude-opus-4.7 then claude-opus-4.6, else drop out.")
    p.add_argument("--resume", metavar="SESSION_ID", help="Continue an existing Kiro session.")
    p.add_argument("--timeout", type=float, default=1800, help="Max seconds for the turn (default 1800).")
    p.add_argument("--trust-tools", help="Comma-separated allowlist passed to kiro's --trust-tools.")
    p.add_argument("--no-trust", action="store_true", help="Do not pass --trust-all-tools.")
    p.add_argument("--quiet", action="store_true", help="Hide tool-call progress on stderr.")
    p.add_argument("--verbose", action="store_true", help="Also stream Kiro's thinking to stderr.")
    p.add_argument("--json", action="store_true",
                   help="Emit a JSON summary on stdout instead of streaming the reply.")
    return p.parse_args()


def main():
    args = parse_args()
    prompt = args.prompt if args.prompt is not None else sys.stdin.read()
    prompt = (prompt or "").strip()
    if not prompt:
        eprint("error: empty prompt (pass an argument or pipe text on stdin)")
        return 2

    if args.model is None:
        resolved = resolve_preferred_model()
        if resolved is None:
            return 3
        eprint(f"→ model {resolved}")
        args.model = resolved

    client = KiroACP(args)
    try:
        client.run(prompt)
    except (TimeoutError, RuntimeError, BrokenPipeError) as e:
        eprint(f"error: {e}")
        err = client.proc.stderr.read() if client.proc and client.proc.stderr else ""
        if err.strip():
            eprint("--- kiro-cli stderr ---")
            eprint(err.strip()[:2000])
        client.close()
        return 1

    client.summary_to_stderr()
    if args.json:
        print(json.dumps({
            "sessionId": client.session_id,
            "stopReason": client.stop_reason,
            "text": "".join(client._chunks),
            "metadata": client._meta,
        }, indent=2))
    client.close()
    return 0 if client.stop_reason == "end_turn" else 1


if __name__ == "__main__":
    sys.exit(main())
