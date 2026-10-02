import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
  await page.goto(new URL('./social.html', import.meta.url).href)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: fileURLToPath(new URL('../docs/social-preview.png', import.meta.url)) })
} finally {
  await browser.close()
}
