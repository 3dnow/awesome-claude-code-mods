#!/usr/bin/env node
// Finds every GitHub repository that might contain a Claude Mod: two code
// searches plus data/seeds.txt (repos the search index has not caught up with).
// Writes data/repos.txt, one owner/repo per line. Needs `gh` logged in, or
// GH_TOKEN in the environment.

import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { readRepos, mergeRepos } from './candidates.mjs'

const QUERIES = [
  'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS',
  '"modules" filename:hooks.json path:hooks',
]

function sleep(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.ceil(seconds * 1000))
}

const PER_PAGE = 100
const MAX_RESULTS = 1000
const MAX_FILE_BYTES = 384 * 1024

// File-size partitions bypass GitHub's per-query cap; inconsistent snapshots fail instead of losing candidates.
export function search(q, run = ghSearchPage, attempts = 4, wait = sleep, pause = 10) {
  let requests = 0
  const page = (query, n) => retry(() => {
    if (requests++) wait(pause)
    const result = run(query, n)
    if (result.incomplete_results === true) {
      const error = new Error(`incomplete search results for ${query}`)
      error.retryable = true
      throw error
    }
    if (!Number.isInteger(result.total_count) || result.total_count < 0 || result.incomplete_results !== false || !Array.isArray(result.items)) {
      throw new Error(`invalid search response for ${query}`)
    }
    return result
  }, query, attempts, wait)
  const unstable = message => {
    const error = new Error(message)
    error.unstable = true
    throw error
  }
  const collect = (query, first) => {
    const items = [...first.items]
    for (let n = 2; n <= Math.ceil(first.total_count / PER_PAGE); n++) {
      const next = page(query, n)
      if (next.total_count !== first.total_count) unstable(`search count changed while paging ${query}`)
      items.push(...next.items)
    }
    const files = new Set(items.map(item => {
      if (!item.repository?.full_name || typeof item.path !== 'string') throw new Error(`invalid search item for ${query}`)
      return `${item.repository.full_name.toLowerCase()}:${item.path}`
    }))
    if (files.size !== first.total_count || items.length !== first.total_count) unstable(`partial pagination for ${query}: got ${files.size} of ${first.total_count} files`)
    return items
  }
  const partition = (lo, hi) => {
    const query = `${q} size:${lo}..${hi}`
    const first = page(query, 1)
    if (first.total_count <= MAX_RESULTS) {
      try { return collect(query, first) } catch (error) {
        if (!error.unstable || lo === hi) throw error
        console.error(`${error.message}; splitting into smaller searches`)
      }
    }
    if (lo === hi) throw new Error(`search still capped at file size ${lo} for ${q}; refusing partial discovery`)
    const mid = Math.floor((lo + hi) / 2)
    const items = [...partition(lo, mid), ...partition(mid + 1, hi)]
    return items
  }
  const first = page(q, 1)
  if (first.total_count <= MAX_RESULTS) {
    try { return collect(q, first).map(item => item.repository.full_name) } catch (error) {
      if (!error.unstable) throw error
      console.error(`${error.message}; splitting into smaller searches`)
    }
  }
  const items = partition(0, MAX_FILE_BYTES - 1)
  // Check the tail too, so a future increase in GitHub's file-size limit cannot lose results silently.
  const tailQuery = `${q} size:>=${MAX_FILE_BYTES}`
  const tail = page(tailQuery, 1)
  if (tail.total_count > MAX_RESULTS) throw new Error(`search capped beyond supported file-size range for ${q}`)
  items.push(...collect(tailQuery, tail))
  // Independent queries do not share an index snapshot. Each leaf must be complete; parent totals can move meanwhile.
  if (items.length !== first.total_count) console.error(`search index changed during ${q}: initial ${first.total_count} files, complete partitions returned ${items.length}`)
  return items.map(item => item.repository.full_name)
}

function retry(fn, q, attempts, wait) {
  let last
  for (let i = 1; i <= attempts; i++) {
    try {
      return fn()
    } catch (e) {
      last = e
      const msg = e.stderr?.toString().trim() || e.message
      const hinted = /try again in (\d+(?:\.\d+)?)s/.exec(msg)
      const limited = e.retryable || hinted || /HTTP (403|429)/.test(msg)
      console.error(`search failed for ${q} (attempt ${i} of ${attempts}): ${msg}`)
      if (!limited || i === attempts) break
      wait(Math.max(hinted ? Math.ceil(Number(hinted[1])) + 1 : 0, 60 * i))
    }
  }
  throw new Error(`code search failed for ${q}: ${last?.stderr?.toString().trim() || last?.message}`)
}

function ghSearchPage(q, page) {
  const out = execFileSync('gh', ['api', '-X', 'GET', 'search/code', '-f', `q=${q}`, '-f', `per_page=${PER_PAGE}`, '-f', `page=${page}`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return JSON.parse(out)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seeds = readRepos('data/seeds.txt')
  const previous = readRepos('data/repos.txt')
  const discovered = QUERIES.flatMap(q => search(q))
  mkdirSync('data', { recursive: true })
  const repos = mergeRepos(previous, seeds, discovered)
  writeFileSync('data/repos.txt', repos.join('\n') + '\n')
  console.log(`${repos.length} candidate repos (${seeds.length} seeds)`)
}
