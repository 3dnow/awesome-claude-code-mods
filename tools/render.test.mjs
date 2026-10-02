import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const renderer = fileURLToPath(new URL('./render.mjs', import.meta.url))
const mod = (i, status = 'passed', kind = 'mod') => ({
  repo: 'example/mods', path: `plugins/mod-${i}`, name: `mod-${i}`, kind,
  description: `Example mod ${i}`, url: 'https://example.com', stars: i,
  reach: { level: i % 4, labels: [] }, sees: [], hooks: [], calls: [], surfaceModules: [],
  validate: { status, errors: status === 'failed' ? ['name: Plugin name is reserved.'] : [] },
})

function fixture(t, mods) {
  const dir = mkdtempSync(join(tmpdir(), 'mods-render-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'data'))
  writeFileSync(join(dir, 'data/mods.json'), JSON.stringify({ generated: '2026-01-01T00:00:00Z', claudeVersion: '2.1.287', repos: 1, mods }))
  writeFileSync(join(dir, 'README.md'), ['stats', 'scan', 'builtin'].map(name => `<!-- ${name}:start -->\n<!-- ${name}:end -->`).join('\n'))
  return dir
}

const render = dir => execFileSync(process.execPath, [renderer], { cwd: dir, stdio: 'pipe' })

test('render preserves failures, distinguishes unknown results and removes excluded badges', t => {
  const dir = fixture(t, [mod(0), mod(1, 'warnings'), mod(2, 'failed'), mod(3, 'unknown'), mod(4, 'passed', 'fixture')])
  for (const folder of ['badges', 'docs/badges']) {
    mkdirSync(join(dir, folder), { recursive: true })
    writeFileSync(join(dir, folder, 'example--mods--mod-4-reach.svg'), 'old badge')
    writeFileSync(join(dir, folder, 'custom.svg'), 'keep')
  }
  render(dir)
  const readme = readFileSync(join(dir, 'README.md'), 'utf8')
  const page = readFileSync(join(dir, 'docs/index.html'), 'utf8')
  assert.match(readme, /\*\*4 mods\*\*/)
  assert.match(readme, /fails on 2\.1\.287/)
  assert.match(readme, /not verified/)
  assert.doesNotMatch(readme, /mod-4/)
  assert.match(page, /Plugin name is reserved/)
  assert.match(page, /not a runtime compatibility test/)
  for (const folder of ['badges', 'docs/badges']) {
    assert.equal(existsSync(join(dir, folder, 'example--mods--mod-4-reach.svg')), false)
    assert.equal(existsSync(join(dir, folder, 'custom.svg')), true)
    assert.match(readFileSync(join(dir, folder, 'example--mods--mod-1-validates.svg'), 'utf8'), /#2da44e/)
    assert.match(readFileSync(join(dir, folder, 'example--mods--mod-2-validates.svg'), 'utf8'), /fails on 2\.1\.287/)
    const unknown = readFileSync(join(dir, folder, 'example--mods--mod-3-validates.svg'), 'utf8')
    assert.match(unknown, /not verified/)
    assert.doesNotMatch(unknown, /#2da44e/)
  }
})

test('scoreboard stays within desktop and mobile viewports as the scan grows', async t => {
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.route('https://**/*', route => route.abort())
  for (const count of [72, 364, 1000]) {
    const dir = fixture(t, Array.from({ length: count }, (_, i) => mod(i)))
    render(dir)
    await page.goto(pathToFileURL(join(dir, 'docs/index.html')).href)
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      const sizes = await page.evaluate(() => {
        const strip = document.querySelector('.strip').getBoundingClientRect()
        const segments = [...document.querySelectorAll('.seg')].map(el => el.getBoundingClientRect())
        return {
          document: document.documentElement.scrollWidth,
          equalWidths: Math.max(...segments.map(r => r.width)) - Math.min(...segments.map(r => r.width)) < 1,
          contained: segments.every(r => r.left >= strip.left - 1 && r.right <= strip.right + 1 && r.top >= strip.top - 1 && r.bottom <= strip.bottom + 1 && r.width >= 3 && r.height >= 16),
        }
      })
      assert.ok(sizes.document <= width, `${count} mods at ${width}px: document is ${sizes.document}px`)
      assert.ok(sizes.contained, `${count} mods at ${width}px: reach segments escape their strip`)
      assert.ok(sizes.equalWidths, `${count} mods at ${width}px: segments have unequal widths`)
    }
    await page.locator('.lv[data-level="3"]').click()
    assert.equal(await page.locator('#t tbody tr:visible').count(), Math.floor(count / 4))
    await page.locator('.lv[data-level="3"]').click()
    await page.locator('#q').fill('Example mod 0')
    assert.equal(await page.locator('#t tbody tr:visible').count(), 1)
  }
})

test('catalogue combines filters and recovers from an empty result', async t => {
  const dir = fixture(t, [...Array.from({ length: 8 }, (_, i) => mod(i)), mod(8, 'passed', 'builtin')])
  render(dir)
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.route('https://**/*', route => route.abort())
  await page.goto(pathToFileURL(join(dir, 'docs/index.html')).href)
  const rows = page.locator('#t tbody tr:visible')

  assert.equal(await rows.count(), 8)
  assert.equal(await page.locator('#empty').isVisible(), false)
  await page.locator('.lv[data-level="3"]').click()
  assert.equal(await rows.count(), 2)
  assert.equal(await page.locator('.lv[data-level="3"]').getAttribute('aria-pressed'), 'true')
  await page.locator('#q').fill('Example mod 0')
  assert.equal(await rows.count(), 0)
  assert.equal(await page.locator('#empty').isVisible(), true)
  assert.match(await page.locator('#n').textContent(), /0 of 8 mods/)

  await page.locator('#reset').click()
  assert.equal(await page.locator('#q').inputValue(), '')
  assert.equal(await rows.count(), 8)
  assert.equal(await page.locator('.lv:not(.all)[aria-pressed="true"]').count(), 0)
  assert.equal(await page.locator('.lv.all').getAttribute('aria-pressed'), 'true')
  assert.equal(await page.locator('#empty').isVisible(), false)
  assert.match(await page.locator('#n').textContent(), /8 mods/)
  await page.locator('#q').fill('eXaMpLe MoD 3')
  assert.equal(await rows.count(), 1)
  assert.match(await page.locator('#search-results').textContent(), /View 1 matching mod\s/)
  await page.locator('#clear-search').click()
  assert.equal(await rows.count(), 8)
  assert.equal(await page.locator('#q').inputValue(), '')
  assert.equal(await page.locator('#q').evaluate(el => el === document.activeElement), true)
  await page.locator('#q').fill('EXAMPLE/MODS')
  assert.equal(await rows.count(), 8)
})

test('sorting retains filters and reach links reveal their target consistently', async t => {
  const dir = fixture(t, Array.from({ length: 12 }, (_, i) => mod(i)))
  render(dir)
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('https://**/*', route => route.abort())
  await page.goto(pathToFileURL(join(dir, 'docs/index.html')).href)
  const stars = () => page.locator('#t tbody tr:visible').evaluateAll(rows => rows.map(row => Number(row.dataset.stars)))

  await page.locator('.lv[data-level="3"]').click()
  await page.locator('#t th button[data-k="stars"]').click()
  assert.deepEqual(await stars(), [3, 7, 11])
  await page.locator('#t th button[data-k="stars"]').click()
  assert.deepEqual(await stars(), [11, 7, 3])
  await page.locator('#q').fill('no matching mod')
  assert.equal(await page.locator('#t tbody tr:visible').count(), 0)

  await page.locator('.seg[href="#example--mods--mod-0"]').click()
  assert.equal(await page.locator('#example--mods--mod-0').isVisible(), true)
  assert.equal(await page.locator('#q').inputValue(), '')
  assert.equal(await page.locator('#empty').isVisible(), false)
  const visible = await page.locator('#t tbody tr:visible').count()
  assert.equal(Number((await page.locator('#n').textContent()).match(/\d+/)[0]), visible)
  assert.equal(new URL(page.url()).hash, '#example--mods--mod-0')
  assert.deepEqual(errors, [])
})

test('landing metadata and browse links use the published catalogue', async t => {
  const dir = fixture(t, [mod(0)])
  render(dir)
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.route('https://**/*', route => route.abort())
  await page.goto(pathToFileURL(join(dir, 'docs/index.html')).href)

  assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), 'https://mods.aidojo.si/')
  assert.equal(await page.locator('meta[property="og:url"]').getAttribute('content'), 'https://mods.aidojo.si/')
  assert.equal(await page.locator('h1').count(), 1)
  const missingTargets = await page.locator('a[href^="#"]').evaluateAll(links => links
    .map(link => link.getAttribute('href').slice(1))
    .filter(id => id && !document.getElementById(decodeURIComponent(id))))
  assert.deepEqual(missingTargets, [])
  assert.equal(await page.locator('#q').getAttribute('type'), 'search')
  assert.ok(await page.locator('#q').getAttribute('aria-label') || await page.locator('label[for="q"]').count())
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.getByRole('columnheader', { name: 'What it does', exact: true }).count(), 1)
})
