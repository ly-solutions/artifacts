#!/usr/bin/env node
/**
 * Fails when a runtime dependency (direct or transitive) has a license outside the allow-list,
 * so nothing incompatible with Apache-2.0 ends up in the image or the npm package.
 *   node scripts/check-licenses.mjs [--all]   (--all includes dev dependencies)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ALLOWED = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense', 'Python-2.0', 'CC-BY-4.0'])
const includeDev = process.argv.includes('--all')

const tree = JSON.parse(execFileSync('npm', ['ls', '--all', '--json', ...(includeDev ? [] : ['--omit=dev'])], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
const seen = new Map()
const walk = (deps = {}) => {
  for (const [name, info] of Object.entries(deps)) {
    if (!info.version || seen.has(`${name}@${info.version}`)) continue
    let license = 'UNKNOWN'
    try {
      const pkg = JSON.parse(readFileSync(join(info.path ?? join('node_modules', name), 'package.json'), 'utf8'))
      license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (pkg.licenses?.map((l) => l.type).join(' OR ') || 'UNKNOWN')
    } catch {
      /* missing package.json: reported as UNKNOWN */
    }
    seen.set(`${name}@${info.version}`, license)
    walk(info.dependencies)
  }
}
walk(tree.dependencies)

// "(MIT OR Apache-2.0)" passes if any alternative is allowed; "MIT AND X" needs all.
const ok = (expr) => {
  const clean = expr.replace(/[()]/g, ' ').trim()
  if (clean.includes(' OR ')) return clean.split(' OR ').some((part) => ok(part))
  if (clean.includes(' AND ')) return clean.split(' AND ').every((part) => ok(part))
  return ALLOWED.has(clean.trim())
}

const bad = []
for (const [pkg, license] of [...seen].sort()) {
  console.log(`${ok(license) ? 'ok ' : 'BAD'}  ${license.padEnd(24)} ${pkg}`)
  if (!ok(license)) bad.push(pkg)
}
console.log(`\n${seen.size} ${includeDev ? '' : 'runtime '}packages checked`)
if (bad.length) {
  console.error(`not allowed: ${bad.join(', ')}`)
  process.exit(1)
}
