import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = 'http://127.0.0.1:5173'
const outDir = '/tmp/gpxto3mf-e2e'
fs.mkdirSync(outDir, { recursive: true })

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  page.on('console', (msg) => console.log('BROWSER:', msg.type(), msg.text()))
  page.on('pageerror', (err) => console.log('PAGEERROR:', err.message))

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('.brand')
  const brand = await page.locator('.brand').textContent()
  if (brand?.trim() !== 'gpxto3mf') throw new Error(`Bad brand: ${brand}`)

  // Upload GPX via file input
  const gpxPath = path.resolve('/agent/public/sample.gpx')
  await page.locator('input[type=file][accept*="gpx"]').setInputFiles(gpxPath)

  // Wait for pipeline to finish (status contains mm or AMS)
  await page.waitForFunction(
    () => {
      const s = document.querySelector('.status')?.textContent || ''
      return /AMS slots|mm/.test(s) && !document.querySelector('.status.busy')
    },
    { timeout: 120_000 },
  )

  const status = await page.locator('.status').textContent()
  console.log('STATUS:', status)

  // Import palette
  await page
    .locator('input[type=file][accept*="json"]')
    .setInputFiles('/agent/public/sample-palette.json')
  await page.waitForTimeout(2000)
  await page.waitForFunction(
    () => !document.querySelector('.status.busy'),
    { timeout: 120_000 },
  )

  // Download 3MF
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByRole('button', { name: 'Download 3MF' }).click(),
  ])
  const savePath = path.join(outDir, await download.suggestedFilename())
  await download.saveAs(savePath)
  const size = fs.statSync(savePath).size
  console.log('3MF:', savePath, size)
  if (size < 1000) throw new Error('3MF too small')

  // Verify zip magic
  const buf = fs.readFileSync(savePath)
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('Not a zip/3MF')

  await page.screenshot({ path: path.join(outDir, 'preview.png'), fullPage: true })
  console.log('OK')
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
