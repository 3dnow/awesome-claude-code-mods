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
