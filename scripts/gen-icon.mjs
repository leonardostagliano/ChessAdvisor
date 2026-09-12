// Generates the app and tray icons from the logo SVG, at the native sizes Windows asks
// for at every DPI. Usage: node scripts/gen-icon.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const root = process.cwd()
const svg = readFileSync(resolve(root, 'src/renderer/assets/chessadvisor-logo.svg'))

mkdirSync(resolve(root, 'resources'), { recursive: true })
mkdirSync(resolve(root, 'build'), { recursive: true })

const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const pngs = []
for (const size of sizes) {
  const buffer = await sharp(svg, { density: 640 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
  pngs.push(buffer)
  if (size === 256) writeFileSync(resolve(root, 'resources/icon.png'), buffer)
}

const ico = await pngToIco(pngs)
writeFileSync(resolve(root, 'build/icon.ico'), ico)
writeFileSync(resolve(root, 'resources/tray.ico'), ico)
console.log('Icons generated: resources/icon.png, resources/tray.ico, build/icon.ico (16..256)')
