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
- `tester/flows/*.mjs` are the checks. Each one takes `<web_url> <out_dir> <before|after>`;
  [Writing a tester flow](#writing-a-tester-flow) is how to add one.
- `.github/workflows/workbench.yml` is the dispatchable run. Read its header before adding
  anything to it: the job deliberately holds no secret.

Run locally (needs Docker, uv, Node 24):

```bash
boot/up.sh ../lemma-platform 18710 13000 /tmp/wb/head
(cd tester && npm ci && node flows/signup.mjs http://localhost:13000 /tmp/wb/evidence after)
boot/down.sh /tmp/wb/head
```

## Writing a tester flow

A flow is one `.mjs` file under `tester/flows/`. `qa.mjs` does the recording; the flow only
says what to do.

**Arguments.** Positional, in this order:

| argument | meaning |
| --- | --- |
| `<web_url>` | the frontend to drive, e.g. `http://localhost:13000` |
| `<out_dir>` | where the evidence lands |
| `<before\|after>` | which stack this run is of, so a flow's two runs stay apart; defaults to `after` |

**The body.** `check({ name, phase, base, out }, body)` starts the browser with `base` as its
`baseURL` and hands the body `{ page, context, step, expect }`. `page` and `expect` are
Playwright's; `step` is the recorder.

**What `step(title, fn)` records.** Each call runs `fn` and appends one entry to
`<out_dir>/<name>-<phase>/result.json`:

- `n`, `title`, `status` (`pass` or `fail`) and `seconds`;
- `url`, the page's url when the step ended;
- `screenshot`, the file `NN-<title-slug>.png` — written after every step, passed or failed.

A step that throws is recorded `fail` with the first six lines of its message, and the steps
after it do not run. So put one action and the assertion that it worked in the same step: a
failure then names the step that broke.

**Where evidence lands.** Everything from one run is in `<out_dir>/<name>-<phase>/`:

| file | what it is |
| --- | --- |
| `video.webm` | the whole run |
| `trace.zip` | the Playwright trace, `npx playwright show-trace trace.zip` |
| `NN-<step>.png` | one screenshot per step |
| `result.json` | the steps above, plus the verdict, console errors, failed requests and timings |

The verdict is `pass` only when every step ran and passed. A step that throws is `fail`.
Anything that stops the run before its first step — the browser will not start, the stack does
not answer — is `could_not_tell`: never a pass, and never a product fail.

**A worked example.** Save this as `tester/flows/sign-in.mjs`:

```js
// The sign-in page renders and offers a way to make an account.
import { check } from '../qa.mjs'
const [base, out, phase = 'after'] = process.argv.slice(2)
await check({ name: 'sign-in', phase, base, out }, async ({ page, step, expect }) => {
  await step('open the sign-in page', () => page.goto('/auth', { waitUntil: 'networkidle' }))
  await step('it offers to make an account', () =>
    expect(page.getByRole('link', { name: 'Make an account' })).toBeVisible())
})
```

Run it against a booted stack and read the verdict back:

```bash
boot/up.sh ../lemma-platform 18710 13000 /tmp/wb/head
(cd tester && npm ci && node flows/sign-in.mjs http://localhost:13000 /tmp/wb/evidence after)
cat /tmp/wb/evidence/sign-in-after/result.json
```

It prints one line — `{"name":"sign-in","phase":"after","verdict":"pass","steps":2,"dir":"…"}` —
and leaves the video, the trace and one screenshot per step beside it.

In CI, name the flow in the `flows` dispatch input and `workbench.yml` runs it twice: as
`before` against the base stack and `after` against the head stack. `tester/flows/signup.mjs`
is the fullest example, a whole sign-up through to the product.

## Logos experiments

The Logos pod (`gappyai/lemma-pods`, `pods/LOGOS`) runs its claim experiments here as well.
- **What an experiment is:** a branch `logos-exp/<key>`, pushed by the pod's `run_experiments` function through the GitHub connector, holding `pods/LOGOS/experiments/<key>/` (a pytest file against lemma-platform's scenario harness, plus its monitors).
- **What the push does:** it starts `.github/workflows/logos-experiment.yml`. The workflow boots the stack with the platform's own harness, records every span with an OpenTelemetry collector, and uploads JUnit, the spans and a fault log as the artifact `logos-<key>`. The pod collects that artifact and decides the verdict.
- **The fault kit:** `pods/LOGOS/runner/logos_faults.py` is a copy of the one in lemma-pods. It kills and restarts a worker at a telemetry breakpoint, replays stream entries, destroys consumer groups and reads SQL.

Like `workbench.yml`, the job holds no secret.
