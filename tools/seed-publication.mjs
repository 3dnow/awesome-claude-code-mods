import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { mergeRepos, readRepos } from './candidates.mjs'
import { applyDuplicates, readDuplicates, suspectDuplicates } from './dedupe.mjs'

export function pendingSeeds(seeds, inventory) {
  const published = new Set(inventory.mods.map(mod => mod.repo.toLowerCase()))
  return mergeRepos(seeds).filter(repo => !published.has(repo.toLowerCase()))
}

export function appendSeeds(before, scanned, seeds, candidates, duplicates = new Map()) {
  const wanted = new Set(mergeRepos(seeds).map(repo => repo.toLowerCase()))
  if (!wanted.size) throw new Error('No unpublished seeds')
  if (before.claudeVersion !== scanned.claudeVersion) throw new Error('Use the published validator version for seed additions')
  if (before.mods.some(mod => wanted.has(mod.repo.toLowerCase()))) throw new Error('Seed already published; restart from current main')
  const ids = new Set(before.mods.map(mod => mod.id))
  for (const mod of scanned.mods) {
    if (!wanted.has(mod.repo.toLowerCase())) throw new Error(`Unapproved repository: ${mod.repo}`)
    if (ids.has(mod.id)) throw new Error(`Duplicate plugin ID: ${mod.id}`)
    ids.add(mod.id)
    if (mod.validate.claudeVersion !== before.claudeVersion) throw new Error(`Validator mismatch: ${mod.id}`)
    if (mod.kind !== 'mod') continue
    if (!['passed', 'warnings'].includes(mod.validate.status)) throw new Error(`Validation needs review: ${mod.id}`)
    if ((mod.marketplaces ?? []).some(market => !['passed', 'warnings'].includes(market.status))) throw new Error(`Marketplace needs review: ${mod.id}`)
    if (mod.compatibility?.warnings?.length) throw new Error(`Compatibility needs review: ${mod.id}`)
  }
  for (const repo of wanted) {
    if (!scanned.mods.some(mod => mod.repo.toLowerCase() === repo && mod.kind === 'mod')) throw new Error(`No counted mods in seed: ${repo}`)
  }
  const mods = structuredClone([...before.mods, ...scanned.mods])
  applyDuplicates(mods, duplicates)
  for (let i = 0; i < before.mods.length; i++) {
    if (JSON.stringify(mods[i]) !== JSON.stringify(before.mods[i])) throw new Error('Seed changes an existing duplicate decision; manual review required')
  }
  const addedIds = new Set(scanned.mods.map(mod => mod.id))
  if (suspectDuplicates(mods).some(pair => pair.some(id => addedIds.has(id)))) throw new Error('New possible duplicate needs review')
  const repos = mergeRepos(candidates, seeds)
  // Keep the full-scan timestamp: existing entries were not rescanned.
  return { inventory: { ...before, repos: repos.length, mods }, repos }
}

export function planPublication(before, scanned, requested, approved, candidates, duplicates) {
  const requestedRepos = new Set(mergeRepos(requested).map(repo => repo.toLowerCase()))
  if (scanned.mods.some(mod => !requestedRepos.has(mod.repo.toLowerCase()))) throw new Error('Scan includes a repository that was not requested')
  const pending = pendingSeeds(approved, before).filter(repo => requestedRepos.has(repo.toLowerCase()))
  if (!pending.length) return null
  const selected = new Set(pending.map(repo => repo.toLowerCase()))
  return appendSeeds(before, { ...scanned, mods: scanned.mods.filter(mod => selected.has(mod.repo.toLowerCase())) }, pending, candidates, duplicates)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { prepare: { type: 'boolean' }, repos: { type: 'string' }, scan: { type: 'string' }, result: { type: 'string' } } })
  const inventory = JSON.parse(readFileSync('data/mods.json', 'utf8'))
  if (values.prepare) {
    const pending = pendingSeeds(readRepos('data/seeds.txt'), inventory)
    if (!/^\d+\.\d+\.\d+$/.test(inventory.claudeVersion)) throw new Error('Invalid published validator version')
    writeFileSync(values.repos, pending.join('\n') + (pending.length ? '\n' : ''))
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `pending=${pending.length > 0}\nversion=${inventory.claudeVersion}\n`)
    console.log(`${pending.length} unpublished seed repositories`)
  } else {
    const result = planPublication(inventory, JSON.parse(readFileSync(values.scan, 'utf8')), readRepos(values.repos), readRepos('data/seeds.txt'), readRepos('data/repos.txt'), readDuplicates())
    if (result) {
      writeFileSync('data/mods.json', JSON.stringify(result.inventory, null, 2) + '\n')
      writeFileSync('data/repos.txt', result.repos.join('\n') + '\n')
    }
    if (values.result) writeFileSync(values.result, result ? 'added\n' : 'unchanged\n')
  }
}
