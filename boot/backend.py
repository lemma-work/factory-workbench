"""Boot lemma-platform's backend the way its own scenario suite does, and hold it.

Run from the checkout under test, inside its scenario project:

    cd <platform>/tests/scenarios && uv run python <workbench>/boot/backend.py \
        --port 8710 --frontend http://localhost:3000 --out /tmp/wb/backend.json

It reuses `harness.stack.start_stack`: Postgres, Redis and SuperTokens come up as
containers, migrations run, the native connector catalogue is seeded, and the API
and worker start under uvicorn with the gates that exist to slow real abuse off,
email to the filesystem and a scripted model. This is the same stack the
product's scenario CI boots, so the workbench never carries a recipe of its own
that can drift from it.

It writes `--out` once `/health` answers and then sleeps until it is killed,
when the generator's cleanup tears everything down.
"""

from __future__ import annotations

import argparse
import json
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8710)
    parser.add_argument("--frontend", default="http://localhost:3000")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    import os

    os.environ["SCENARIOS_PORT"] = str(args.port)
    from harness import stack as stack_module

    def configure(spec):
        # The browser comes in through the frontend, so the backend has to
        # name it as its own frontend and allow it as an origin.
        spec.env["FRONTEND_URL"] = args.frontend
        spec.env["AUTH_FRONTEND_URL"] = args.frontend
        spec.env["CORS_ORIGINS"] = json.dumps(
            [args.frontend, args.frontend.replace("localhost", "127.0.0.1")]
        )
        # Convert documents in-process: the harness starts no Kreuzberg container,
        # so the default HTTP converter is refused and every upload stays PENDING.
        if documents["processor"] == "xberg":
            spec.env["DOCUMENT_PROCESSOR"] = "xberg"
            spec.env["KREUZBERG_URL"] = ""

    documents = {"processor": "none", "why": "the backend at this commit has no in-process converter (xberg extra)"}
    probe = subprocess.run(
        [getattr(stack_module, "_backend_python", lambda: sys.executable)(), "-c", "import xberg"], capture_output=True, text=True
    )
    if probe.returncode == 0:
        documents = {"processor": "xberg", "why": "in-process"}

    generator = stack_module.start_stack(configure)
    started = time.monotonic()
    stack = next(generator)
    health = json.loads(urllib.request.urlopen(f"{stack.base_url}/health", timeout=10).read())
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(
        json.dumps(
            {
                "base_url": f"http://localhost:{args.port}",
                "log_path": stack.log_path,
                "health": health,
                "boot_seconds": round(time.monotonic() - started, 1),
                "capabilities": {"documents": documents},
            }
        )
    )
    print(f"backend up on {stack.base_url} in {time.monotonic() - started:.0f}s", flush=True)

    stop = {"now": False}

    def _stop(*_):
        stop["now"] = True

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    while not stop["now"]:
        time.sleep(1)
    try:
        next(generator)
    except StopIteration:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
