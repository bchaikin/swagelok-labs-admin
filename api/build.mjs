// Bundle src/handler.ts into dist/index.mjs (ESM, node20) and zip it for Lambda.
import { build } from 'esbuild'
import { mkdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(here, 'dist')
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

await build({
  entryPoints: [path.join(here, 'src', 'handler.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: path.join(dist, 'index.mjs'),
  // The AWS SDK v3 is provided by the nodejs20.x runtime; bundling it anyway keeps versions pinned.
  minify: false,
  sourcemap: false,
  logLevel: 'warning',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
})

const zip = new AdmZip()
zip.addLocalFile(path.join(dist, 'index.mjs'))
const zipPath = path.join(dist, 'api.zip')
zip.writeZip(zipPath)
console.log(`built ${path.relative(process.cwd(), zipPath)} (${(statSync(zipPath).size / 1024).toFixed(0)} KB)`)
