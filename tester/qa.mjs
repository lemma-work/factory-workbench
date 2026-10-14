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
//   video.webm       the whole run
//   trace.zip        Playwright trace (open with `npx playwright show-trace`)
//   NN-<step>.png    a screenshot after every step, passed or failed
//   result.json      steps, verdict, console errors, failed requests, timings
//
// The verdict is `pass` only when every step ran and passed. A step that throws
// is `fail` with its message, and the steps after it do not run. Anything that
// stops the check before its first step (the browser will not start, the stack
// does not answer) is `could_not_tell`, never a pass and never a product fail.

import { mkdirSync, writeFileSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(process.env.PLAYWRIGHT_FROM || import.meta.url)
const { chromium, expect } = require('playwright/test')

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
  const step = async (title, fn) => {
    if (failed) return
    n += 1
    const t0 = Date.now()
    const record = { n, title, status: 'pass' }
    try {
      await fn()
    } catch (error) {
      record.status = 'fail'
      record.error = String(error.message || error).split('\n').slice(0, 6).join('\n')
      failed = true
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
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ name, phase, verdict: result.verdict, steps: result.steps.length, dir }))
  return result
}
