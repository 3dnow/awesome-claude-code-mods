// Finds candidates pushed since the last scan through repository search. It has its own
// rate limit and sees new repositories before code search indexes their files. A repository
// joins the candidates only when its tree holds a hooks/hooks.json that lists modules, so
// broad queries cannot fill data/repos.txt with plugins that are not mods.

import { execFileSync } from 'node:child_process'
import { ghSearchPage, createSearchRequest } from './github-search.mjs'

// Ordered from most to least specific: when the check limit is reached, the broad query loses out.
export const RECENT_QUERIES = [
  'topic:claude-code-mod',
  'topic:claude-code-mods',
  'topic:claude-mods',
  'topic:function-hooks',
  'claude mod in:name,description',
  'claude mods in:name,description',
  'topic:claude-code-plugin',
]

const PER_PAGE = 100
const MAX_RESULTS = 1000
const HOUR = 3600 * 1000

// The window starts an hour before the last published scan and never reaches back more than
// two days; older repositories are the daily code search's job.
export function recentSince(lastScan, now = Date.now(), { margin = 1, window = 48 } = {}) {
  const floor = now - window * HOUR
  const last = Date.parse(lastScan)
  const since = Number.isFinite(last) ? Math.max(last - margin * HOUR, floor) : floor
  return new Date(since).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function searchRecent(since, request, { queries = RECENT_QUERIES, log = console.error } = {}) {
  const found = new Map()
  for (const q of queries) {
    const query = `${q} pushed:>=${since}`
    for (let page = 1; ; page++) {
      const result = request(query, page)
      if (!Number.isInteger(result.total_count) || !Array.isArray(result.items)) throw new Error(`invalid search response for ${query}`)
      if (page === 1 && result.total_count > MAX_RESULTS) log(`${query} matched ${result.total_count} repositories; checking the ${MAX_RESULTS} pushed most recently`)
      for (const item of result.items) {
        if (typeof item?.full_name !== 'string') throw new Error(`invalid search item for ${query}`)
        const key = item.full_name.toLowerCase()
        if (!found.has(key)) found.set(key, { repo: item.full_name, branch: item.default_branch ?? 'HEAD' })
      }
      if (!result.items.length || page * PER_PAGE >= Math.min(result.total_count, MAX_RESULTS)) break
    }
  }
  return [...found.values()]
}

export function ghApi(path) {
  return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 64 * 1024 * 1024 }))
}

// Same rule as the scanner: a hooks.json inside a folder named hooks, outside node_modules.
// Unreadable trees and hook files count as candidates, so the scanner reports them instead.
export function hasHookModules({ repo, branch }, api = ghApi) {
  const tree = api(`repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`)
  if (tree.truncated) return true
  const paths = (tree.tree ?? [])
    .filter(entry => entry.type === 'blob' && /(^|\/)hooks\/hooks\.json$/.test(entry.path) && !/(^|\/)node_modules\//.test(entry.path))
    .map(entry => entry.path)
  return paths.some(path => {
    const file = api(`repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`)
    try {
      const hooks = JSON.parse(Buffer.from(file.content ?? '', 'base64').toString('utf8'))
      return Array.isArray(hooks?.modules) && hooks.modules.length > 0
    } catch { return true }
  })
}

export function findRecent(since, known, {
  request = createSearchRequest({
    run: (q, page) => ghSearchPage(q, page, execFileSync, { endpoint: 'search/repositories', sort: 'updated' }),
    pause: 3, label: 'repository search',
  }),
  api = ghApi, limit = 200, log = console.error,
} = {}) {
  const seen = new Set(known.map(repo => repo.toLowerCase()))
  const fresh = searchRecent(since, request, { log }).filter(candidate => !seen.has(candidate.repo.toLowerCase()))
  if (fresh.length > limit) log(`checking ${limit} of ${fresh.length} new repositories; the rest wait for the next run or the daily code search`)
  const found = []
  for (const candidate of fresh.slice(0, limit)) {
    try {
      if (hasHookModules(candidate, api)) found.push(candidate.repo)
    } catch (error) {
      const reason = String(error.stderr || error.message).trim().split('\n').at(-1)
      log(`skipped ${candidate.repo}: ${reason}`)
    }
  }
  return found
}
