// A new person makes an account in the UI and reaches the product.
import { check } from '../qa.mjs'
const [base, out, phase = 'after'] = process.argv.slice(2)
const email = `ada.${Date.now()}@example.com`
await check({ name: 'signup', phase, base, out }, async ({ page, step, expect }) => {
  await step('open the sign-in page', () => page.goto('/auth', { waitUntil: 'networkidle' }))
  await step('choose to make an account', () => page.getByRole('link', { name: 'Make an account' }).click())
  await step('fill email and password', async () => {
    await page.locator('input[type=email]').fill(email)
    await page.locator('input[type=password]').first().fill('ScenarioPassword@123')
  })
  await step('submit', async () => {
    await page.locator('button[type=submit]').click()
    await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 30000 })
  })
  await step('asked who they work with', () => expect(page.getByText('Who will you be working with?')).toBeVisible())
  await step('create the organization', async () => {
    await page.getByRole('button', { name: 'Create my organization' }).click()
    await expect(page.getByText('Before you start')).toBeVisible({ timeout: 30000 })
  })
  await step('give their name', async () => {
    await page.getByLabel('First name').fill('Ada')
    await page.getByLabel('Last name').fill('Member')
    await page.getByRole('dialog').getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('Before you start')).toBeHidden()
  })
  await step('home asks what needs doing', () => expect(page.getByText('What needs doing?')).toBeVisible())
  await step('the product is on screen', () => expect(page.locator('body')).not.toContainText('Something went wrong'))
})
