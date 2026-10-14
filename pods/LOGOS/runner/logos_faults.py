"""Logos fault kit: the faults a claim about crashes, retries and redelivery needs.

Copied next to every experiment by the "Logos experiment" workflow, so a test can say

    from .logos_faults import kill_worker, kill_worker_at, restart_worker, redis, xgroup_destroy, redeliver, sql

and break the stack in the exact way the claim is about. The stack runs as plain processes on the
runner (uvicorn + `python -m app.worker`), so a worker is a pid we can kill and start again with
the same command, environment and directory. Every fault is written to faults.jsonl, which the
runner uploads, so the verdict can say what was done and when.

Standard library only (plus psycopg, which the scenario suite already depends on, for `sql`).
"""
from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import time
from urllib.parse import urlparse

SPANS = os.environ.get("LOGOS_SPANS", "")
LOG = os.environ.get("LOGOS_FAULTS_LOG", "/tmp/logos-faults.jsonl")
_saved: list[dict] = []


def _note(kind, **detail):
    with open(LOG, "a") as fh:
        fh.write(json.dumps({"t": time.time(), "fault": kind, **detail}) + "\n")


def _procs(match: str):
    out = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            cmd = open(f"/proc/{pid}/cmdline", "rb").read().split(b"\0")
        except OSError:
            continue
        args = [c.decode(errors="replace") for c in cmd if c]
        if match in " ".join(args):
            out.append((int(pid), args))
    return out


def workers():
    """Pids of the running workers (`python -m app.worker`)."""
    return [pid for pid, _ in _procs("-m app.worker")]


def kill_worker(sig: int = signal.SIGKILL, restart: bool = True, wait: float = 0.0, which: int = 0):
    """Kill one worker (SIGKILL by default: no cleanup, like a crashed node), then start it again.

    Its command, environment and directory are captured first, so the replacement is the same worker.
    """
    pids = workers()
    if not pids:
        raise RuntimeError("no worker is running")
    pid = pids[which % len(pids)]
    args = open(f"/proc/{pid}/cmdline", "rb").read().split(b"\0")
    env = dict(e.split(b"=", 1) for e in open(f"/proc/{pid}/environ", "rb").read().split(b"\0") if b"=" in e)
    saved = {"args": [a.decode() for a in args if a], "env": {k.decode(): v.decode(errors="replace") for k, v in env.items()},
             "cwd": os.readlink(f"/proc/{pid}/cwd")}
    _saved.append(saved)
    os.kill(pid, sig)
    _note("kill_worker", pid=pid, signal=int(sig))
    for _ in range(100):
        if not os.path.exists(f"/proc/{pid}") or open(f"/proc/{pid}/stat").read().split()[2] == "Z":
            break
        time.sleep(0.05)
    if restart:
        if wait:
            time.sleep(wait)
        return restart_worker()
    return None


def restart_worker():
    """Start the last killed worker again, exactly as it was started."""
    if not _saved:
        raise RuntimeError("no worker was killed")
    s = _saved[-1]
    log = open(os.environ.get("LOGOS_WORKER_LOG", "/tmp/logos-worker-restarted.log"), "ab")
    p = subprocess.Popen(s["args"], env=s["env"], cwd=s["cwd"], stdout=log, stderr=subprocess.STDOUT)
    _note("restart_worker", pid=p.pid)
    return p.pid


def _span_matches(line: str, name: str, attrs: dict) -> bool:
    if name not in line:
        return False
    try:
        doc = json.loads(line)
    except json.JSONDecodeError:
        return False
    for rs in doc.get("resourceSpans", []):
        for ss in rs.get("scopeSpans", []):
            for s in ss.get("spans", []):
                if s.get("name") != name:
                    continue
                got = {a["key"]: next(iter(a.get("value", {}).values()), None) for a in s.get("attributes", [])}
                if all(str(got.get(k)) == str(v) for k, v in attrs.items()):
                    return True
    return False


def wait_for_span(name: str, attrs: dict | None = None, timeout: float = 120.0) -> bool:
    """Block until a span with this name (and attributes) has been recorded. Spans arrive in ~1-2 s batches."""
    attrs = attrs or {}
    deadline = time.time() + timeout
    seen = 0
    while time.time() < deadline:
        if SPANS and os.path.exists(SPANS):
            with open(SPANS) as fh:
                fh.seek(seen)
                chunk = fh.read()
                seen += len(chunk.encode())
            if any(_span_matches(line, name, attrs) for line in chunk.splitlines()):
                return True
        time.sleep(0.2)
    return False


def kill_worker_at(name: str, attrs: dict | None = None, timeout: float = 120.0, **kw):
    """Kill the worker as soon as a given span is recorded: a breakpoint made of telemetry."""
    if not wait_for_span(name, attrs, timeout):
        raise RuntimeError(f"span {name} {attrs} never appeared")
    _note("breakpoint", span=name, attrs=attrs or {})
    return kill_worker(**kw)


# -- redis, spoken directly (RESP over a socket) ---------------------------------------------------------
def redis(url: str, *cmd):
    """Run one Redis command, e.g. redis(stack.redis_url, "XPENDING", "agent_events", "agent-events")."""
    u = urlparse(url)
    with socket.create_connection((u.hostname or "127.0.0.1", u.port or 6379), timeout=10) as s:
        if u.password:
            _resp(s, "AUTH", u.password)
        db = (u.path or "/0").strip("/") or "0"
        if db != "0":
            _resp(s, "SELECT", db)
        return _resp(s, *cmd)


def _resp(s, *cmd):
    s.sendall(b"*%d\r\n" % len(cmd) + b"".join(b"$%d\r\n%s\r\n" % (len(x), x) for x in (str(c).encode() for c in cmd)))
    f = s.makefile("rb")

    def read():
        line = f.readline()
        t, body = line[:1], line[1:-2]
        if t == b"+":
            return body.decode()
        if t == b"-":
            raise RuntimeError(body.decode())
        if t == b":":
            return int(body)
        if t == b"$":
            n = int(body)
            if n < 0:
                return None
            data = f.read(n + 2)[:-2]
            return data.decode(errors="replace")
        if t == b"*":
            n = int(body)
            return None if n < 0 else [read() for _ in range(n)]
        raise RuntimeError(f"bad RESP reply {line!r}")
    return read()


def xgroup_destroy(url: str, stream: str, group: str):
    """Lose a consumer group, as a Redis failover or flush would."""
    _note("xgroup_destroy", stream=stream, group=group)
    return redis(url, "XGROUP", "DESTROY", stream, group)


def redeliver(url: str, stream: str, group: str, consumer: str = "logos-thief", min_idle_ms: int = 0):
    """Claim every pending entry of a group for another consumer: the redelivery a crash causes."""
    out = redis(url, "XAUTOCLAIM", stream, group, consumer, str(min_idle_ms), "0-0", "COUNT", "1000")
    _note("redeliver", stream=stream, group=group, claimed=len(out[1]) if out else 0)
    return out


def sql(database_url: str, query: str, params: tuple = ()):
    """Read the database directly to count side effects (never to set up state the product would refuse)."""
    import psycopg
    url = database_url.replace("postgresql+asyncpg://", "postgresql://").replace("postgresql+psycopg://", "postgresql://")
    with psycopg.connect(url) as conn, conn.cursor() as cur:
        cur.execute(query, params)
        return cur.fetchall() if cur.description else cur.rowcount


def replay(url: str, stream: str, contains: str, scan: int = 200):
    """Deliver an event again: re-append the newest entry whose fields mention `contains`.

    This is what a publisher retry or a broker failover does -- the same event, same event id, a
    second time. Whatever dedups (the inbox) has to catch it.
    """
    entries = redis(url, "XREVRANGE", stream, "+", "-", "COUNT", str(scan)) or []
    for entry_id, fields in entries:
        if any(contains in (v or "") for v in fields):
            new_id = redis(url, "XADD", stream, "*", *fields)
            _note("replay", stream=stream, of=entry_id, as_=new_id)
            return new_id
    raise RuntimeError(f"no entry in {stream} mentions {contains!r} among the last {scan}")


def group_state(url: str, stream: str, group: str):
    """The group's pending count and lag, or None when the group does not exist."""
    try:
        groups = redis(url, "XINFO", "GROUPS", stream) or []
    except RuntimeError:
        return None
    for g in groups:
        info = dict(zip(g[0::2], g[1::2]))
        if info.get("name") == group:
            return {"pending": int(info.get("pending") or 0), "lag": int(info.get("lag") or 0) if info.get("lag") is not None else None}
    return None


def wait_drained(url: str, stream: str, group: str, timeout: float = 60.0) -> bool:
    """Block until the group has read and acknowledged everything on the stream."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        st = group_state(url, stream, group)
        if st and st["pending"] == 0 and st["lag"] in (0, None):
            return True
        time.sleep(0.25)
    return False
