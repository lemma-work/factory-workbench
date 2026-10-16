// The tester's recorder. A check is a script of steps against a booted stack;
// this file makes every step leave evidence behind, so a verdict can always be
// traced to what was on the screen when it was reached.
//
//   import { check } from './qa.mjs'
//   await check({ name: 'signup', phase: 'after', base: 'http://localhost:3000', out: '/tmp/qa' },
//     async ({ page, step, expect }) => {
//       await step('open sign-up', () => page.goto('/auth'))
//       await step('the dashboard greets alice', () => expect(page.getByText('Welcome')).toBeVisible())
//     })
//
// What lands in <out>/<name>-<phase>/:
//   video.webm       the whole run at real speed, except that a stretch where nothing on screen
//                    changes for more than 10 s plays as 5 s (video_cuts in result.json says where)
//   trace.zip        Playwright trace (open with `npx playwright show-trace`)
//   NN-<step>.png    a screenshot after every step, passed or failed
//   result.json      steps, verdict, console errors, failed requests, timings
//
// Every step has a deadline (60 s unless the step says otherwise: step(title, fn, { timeout })),
// so a page that never changes fails the step instead of filling minutes of video.
//
// The verdict is `pass` only when every step ran and passed. A step that throws
// is `fail` with its message, and the steps after it do not run. Anything that
// stops the check before its first step (the browser will not start, the stack
// does not answer) is `could_not_tell`, never a pass and never a product fail.

import { mkdirSync, writeFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(process.env.PLAYWRIGHT_FROM || import.meta.url)
const { chromium, expect } = require('playwright/test')

const STEP_TIMEOUT = 60_000

// One rule: a stretch where the screen does not change for more than STILL seconds plays as
// SHOWN seconds. Everything else stays at real speed. ffmpeg's mpdecimate says which frames changed.
const STILL = 10, SHOWN = 5
function compact(dir, result) {
  const src = join(dir, 'video.webm'), out = join(dir, 'video.compact.webm')
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return
  const seconds = (f) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).stdout?.toString().trim()) || null
  const full = seconds(src)
  result.video_full_seconds = full
  result.video_seconds = full
  if (!full) return
  const probe = spawnSync('ffmpeg', ['-hide_banner', '-i', src, '-vf', 'mpdecimate,showinfo', '-f', 'null', '-'], { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 })
  const changed = [0, ...[...String(probe.stderr ?? '').matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1])), full]
  const cuts = []
  for (let i = 1; i < changed.length; i++) {
    const a = changed[i - 1], b = changed[i]
    if (b - a > STILL) cuts.push([a + SHOWN / 2, b - SHOWN / 2])   // keep the first and last 2.5 s of it
  }
  if (!cuts.length) return
  const expr = cuts.map(([a, b]) => `between(t,${a.toFixed(2)},${b.toFixed(2)})`).join('+')
  const run = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf', `select='not(${expr})',setpts=N/FRAME_RATE/TB`,
    '-c:v', 'libvpx', '-b:v', '1M', '-deadline', 'realtime', '-an', out], { timeout: 180_000 })
  if (run.status !== 0 || !statSync(out, { throwIfNoEntry: false })?.size) { try { unlinkSync(out) } catch {} return }
  renameSync(out, src)
  result.video_seconds = seconds(src)
  result.video_compacted = true
  result.video_cuts = cuts.map(([a, b]) => ({ at: Number(a.toFixed(1)), cut_seconds: Number((b - a).toFixed(1)) }))
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)

export async function check({ name, phase = 'after', base, out, viewport = { width: 1440, height: 900 } }, body) {
  const dir = join(out, `${slug(name)}-${phase}`)
  mkdirSync(dir, { recursive: true })
  const result = { name, phase, base, started_at: new Date().toISOString(), steps: [], console_errors: [], failed_requests: [], verdict: 'could_not_tell' }
  let browser, context, page
  try {
    browser = await chromium.launch()
    context = await browser.newContext({ baseURL: base, viewport, recordVideo: { dir, size: viewport } })
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false })
    page = await context.newPage()
    page.on('console', (m) => { if (m.type() === 'error') result.console_errors.push(m.text().slice(0, 500)) })
    page.on('pageerror', (e) => result.console_errors.push(`pageerror: ${String(e).slice(0, 500)}`))
    page.on('requestfailed', (r) => result.failed_requests.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`))
    page.on('response', (r) => { if (r.status() >= 500) result.failed_requests.push(`${r.status()} ${r.request().method()} ${r.url()}`) })
  } catch (error) {
    result.error = `could not start the browser: ${error.message}`
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2))
    await browser?.close()
    return result
  }

  let n = 0
  let failed = false
  const step = async (title, fn, { timeout = STEP_TIMEOUT } = {}) => {
    if (failed) return
    n += 1
    const t0 = Date.now()
    const record = { n, title, status: 'pass' }
    let timer
    try {
      await Promise.race([fn(), new Promise((_, no) => { timer = setTimeout(() => no(new Error(`still not done after ${timeout / 1000} s`)), timeout) })])
    } catch (error) {
      record.status = 'fail'
      record.error = String(error.message || error).split('\n').slice(0, 6).join('\n')
      failed = true
    } finally {
      clearTimeout(timer)
    }
    record.seconds = (Date.now() - t0) / 1000
    record.url = page.url()
    record.screenshot = `${String(n).padStart(2, '0')}-${slug(title)}.png`
    await page.screenshot({ path: join(dir, record.screenshot) }).catch(() => { record.screenshot = null })
    result.steps.push(record)
  }

  try {
    await body({ page, context, step, expect })
    result.verdict = result.steps.length === 0 ? 'could_not_tell' : failed ? 'fail' : 'pass'
  } catch (error) {
    result.verdict = 'could_not_tell'
    result.error = String(error.message || error).slice(0, 1000)
  }
  result.finished_at = new Date().toISOString()
  await context.tracing.stop({ path: join(dir, 'trace.zip') }).catch(() => {})
  await context.close()
  await browser.close()
  const video = readdirSync(dir).find((f) => f.endsWith('.webm') && f !== 'video.webm')
  if (video) renameSync(join(dir, video), join(dir, 'video.webm'))
  result.video = video ? 'video.webm' : null
  if (video) compact(dir, result)
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ name, phase, verdict: result.verdict, steps: result.steps.length, dir }))
  return result
}
