# factory-workbench

Where the Factory pod tests lemma-platform changes for real. A workflow run boots the
product at a pull request's commit, using the platform's own scenario harness, and boots
its merge base beside it. It then runs the tester's flows against both and keeps the
evidence: video, Playwright trace, a screenshot per step, and server logs. It can also hold
the machine open over SSH for an interactive tester.

- `boot/up.sh <checkout> <api_port> <web_port> <out>` boots one checkout:
  - Postgres, Redis and SuperTokens as containers;
  - migrations, then the API and worker under uvicorn, with email to the filesystem and a
    scripted model;
  - the frontend, built and served.

  It is ready only when `/health` reports that checkout's sha.
- `tester/qa.mjs` makes every check leave evidence behind. Its verdicts are `pass`, `fail`
  or `could_not_tell`.
- `tester/flows/*.mjs` are the checks. Each one takes `<web_url> <out_dir> <before|after>`.
- `.github/workflows/workbench.yml` is the dispatchable run. Read its header before adding
  anything to it: the job deliberately holds no secret.

Run locally (needs Docker, uv, Node 24):

```bash
boot/up.sh ../lemma-platform 18710 13000 /tmp/wb/head
(cd tester && npm ci && node flows/signup.mjs http://localhost:13000 /tmp/wb/evidence after)
boot/down.sh /tmp/wb/head
```

## Logos experiments

The Logos pod (`gappyai/lemma-pods`, `pods/LOGOS`) runs its claim experiments here as well.
- **What an experiment is:** a branch `logos-exp/<key>`, pushed by the pod's `run_experiments` function through the GitHub connector, holding `pods/LOGOS/experiments/<key>/` (a pytest file against lemma-platform's scenario harness, plus its monitors).
- **What the push does:** it starts `.github/workflows/logos-experiment.yml`. The workflow boots the stack with the platform's own harness, records every span with an OpenTelemetry collector, and uploads JUnit, the spans and a fault log as the artifact `logos-<key>`. The pod collects that artifact and decides the verdict.
- **The fault kit:** `pods/LOGOS/runner/logos_faults.py` is a copy of the one in lemma-pods. It kills and restarts a worker at a telemetry breakpoint, replays stream entries, destroys consumer groups and reads SQL.

Like `workbench.yml`, the job holds no secret.

## What a stack can do

`stack.json` carries `capabilities`, read once the backend answers. Today:
`documents.processor` is `xberg` (uploads are converted in-process, so a document reaches
COMPLETED and is searchable) or `none` (this commit has no in-process converter, so every
upload stays PENDING). A check that needs a processed document on a stack that says `none`
is *could not tell*, said up front, not after minutes of waiting.

## Recordings

Every step has a 60 s deadline unless it asks for more (`step(title, fn, { timeout })`).
After a run, ffmpeg (installed by the workflow when the runner lacks it) drops frames that
barely change, at most ~2 s at a time: a 3-minute wait plays as a beat while every change on
screen stays. `result.json` says `video_full_seconds`, `video_seconds` and `video_compacted`.

