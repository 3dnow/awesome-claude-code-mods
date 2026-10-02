#!/usr/bin/env node
// Renders data/mods.json into the README's generated blocks, one SVG badge pair
// per mod under badges/ and docs/badges/, and the directory under docs/.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { LEVEL_NAMES } from './grade.mjs'
import { renderSite } from './site.mjs'

const data = JSON.parse(readFileSync('data/mods.json', 'utf8'))
for (const m of data.mods) m.description = String(m.description ?? '').replace(/\s*[\u2014\u2013]\s*/g, ': ')
const mods = data.mods.filter(m => m.kind === 'mod')
const builtins = data.mods.filter(m => m.kind === 'builtin')
const catalogs = [...new Set(data.mods.filter(m => m.kind === 'catalog').map(m => m.repo))].map(repo => ({ repo, n: data.mods.filter(m => m.kind === 'catalog' && m.repo === repo).length }))
const asOf = data.generated.slice(0, 10)

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/[\[\]]/g, '\\$&').replace(/\n/g, ' ')
// The table links the manifest that was validated, so the curated entries above keep the only link to each repo.
const manifestUrl = m => `https://github.com/${m.repo}/blob/${m.defaultBranch ?? 'main'}/${m.path === '.' ? '' : m.path + '/'}.claude-plugin/plugin.json`
const slug = m => `${m.repo.replace('/', '--')}--${m.name}`.replace(/[^A-Za-z0-9._-]/g, '-')
const short = (s, n = 110) => { s = String(s ?? '').replace(/\s+/g, ' ').replace(/\s*[\u2014\u2013]\s*/g, ': ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s }

const LEVEL_COLORS = ['#2da44e', '#bf8700', '#e36209', '#8250df']
const reachText = m => m.reach.labels.length ? m.reach.labels.join(', ') : 'draws only'
const validates = m => ['passed', 'warnings'].includes(m.validate.status)
const validationText = m => validates(m) ? data.claudeVersion : m.validate.status === 'failed' ? `fails on ${data.claudeVersion}` : 'not verified'

function badge(label, value, color) {
  const w = s => Math.round(s.length * 6.4 + 12)
  const lw = w(label), vw = w(value)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}">
<title>${esc(label)}: ${esc(value)}</title>
<rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/>
<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">
<text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text></g></svg>
`
}

// badges/ is what the README and contributing.md link via raw.githubusercontent.com; docs/badges/ is the same
// set served from the Pages domain.
const BADGE_DIRS = ['badges', 'docs/badges']
for (const dir of BADGE_DIRS) mkdirSync(dir, { recursive: true })
const expectedBadges = new Set([...mods, ...builtins].flatMap(m => [`${slug(m)}-reach.svg`, `${slug(m)}-validates.svg`]))
for (const dir of BADGE_DIRS) {
  for (const file of readdirSync(dir)) {
    if (/-(reach|validates)\.svg$/.test(file) && !expectedBadges.has(file)) unlinkSync(`${dir}/${file}`)
  }
}
const writeBadge = (file, svg) => { for (const dir of BADGE_DIRS) writeFileSync(`${dir}/${file}`, svg) }
for (const m of [...mods, ...builtins]) {
  writeBadge(`${slug(m)}-reach.svg`, badge('reach', `L${m.reach.level} ${reachText(m)}`, LEVEL_COLORS[m.reach.level]))
  writeBadge(`${slug(m)}-validates.svg`, badge('validates on', validationText(m), validates(m) ? '#2da44e' : '#d1242f'))
}

const count = pred => mods.filter(pred).length
const has = label => m => m.reach.labels.includes(label)
const stats = `As of ${asOf}, scanned against Claude Code ${data.claudeVersion}: **${mods.length} mods** in **${data.repos} candidate repos**. `
  + `${count(has('runs processes'))} run host processes, ${count(has('writes files'))} write files, ${count(has('reads files'))} read files, `
  + `${count(has('network'))} reach the network, ${count(m => m.sees.includes('every tool call'))} see every tool call, `
  + `${count(m => m.sees.includes('every prompt'))} see every prompt, ${count(m => m.validate.status === 'failed')} fail to validate on this version. `
  + `Reach levels: ${[0, 1, 2, 3].map(l => `L${l} ${LEVEL_NAMES[l]}: ${count(m => m.reach.level === l)}`).join(' · ')}.`
  + (catalogs.length ? ` Not counted: ${catalogs.map(c => `[${c.repo}](https://github.com/${c.repo}) repackages ${c.n} mods`).join(', ')}, a catalogue named here once instead of once per copy.` : '')

const row = m => [`[${cell(m.name)}](${manifestUrl(m)})`, cell(short(m.description)), `![reach](badges/${slug(m)}-reach.svg)`, cell(m.sees.join(', ') || 'only what it hooks'), validationText(m), String(m.stars ?? '?')]
// awesome-lint wants aligned pipes and padded cells, so every column is padded to its widest cell.
function table(rows) {
  const head = ['Mod', 'What it does', 'Reach', 'Sees', 'Validates on', 'Stars']
  const all = [head, ...rows.map(row)]
  const widths = head.map((_, i) => Math.max(...all.map(r => r[i].length)))
  const line = r => `| ${r.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`
  return [line(head), `| ${widths.map(w => '-'.repeat(w)).join(' | ')} |`, ...rows.map(r => line(row(r)))].join('\n')
}

let readme = readFileSync('README.md', 'utf8')
const replaceBlock = (name, body) => {
  const re = new RegExp(`(<!-- ${name}:start -->)[\\s\\S]*?(<!-- ${name}:end -->)`)
  if (!re.test(readme)) throw new Error(`README is missing the ${name} markers`)
  readme = readme.replace(re, `$1\n${body}\n$2`)
}
replaceBlock('stats', stats)
replaceBlock('scan', table(mods))
replaceBlock('builtin', table(builtins))
writeFileSync('README.md', readme)

const site = renderSite(data)
mkdirSync('docs', { recursive: true })
writeFileSync('docs/index.html', site)
writeFileSync('docs/mods.json', JSON.stringify(data, null, 2) + '\n')
console.log(`rendered ${mods.length} mods and ${builtins.length} built-ins into README.md, badges/, docs/ and docs/badges/`)
