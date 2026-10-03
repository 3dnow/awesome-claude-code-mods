import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recentSince, searchRecent, hasHookModules, findRecent, describeRecent, RECENT_QUERIES } from './recent.mjs'
import { metaQuery, metaBatch, ghGraphql } from './meta.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOUR = 3600 * 1000
const now = Date.parse('2026-10-03T12:00:00Z')
const since = '2026-10-03T08:00:00Z'
const repo = (name, pushed = '2026-10-03T10:00:00Z', branch = 'main') => ({ full_name: name, default_branch: branch, pushed_at: pushed })
const quiet = { log: () => {} }

// files: { 'owner/repo': { 'path/hooks/hooks.json': contents } }, or { truncated: true }, or an Error to throw.
function fakeGitHub(files) {
  const calls = []
  const api = path => {
    calls.push(path)
    const tree = /^repos\/(.+?\/.+?)\/git\/trees\//.exec(path)
    const entry = files[tree[1]]
    if (entry instanceof Error) throw entry
    if (!entry) throw Object.assign(new Error('Command failed'), { stderr: 'gh: Not Found (HTTP 404)\n' })
    return entry.truncated ? { truncated: true, tree: [] } : { truncated: false, tree: Object.keys(entry).map(p => ({ type: 'blob', path: p })) }
  }
  const raw = (name, _, path) => {
    const value = files[name][path]
    return typeof value === 'string' ? value : JSON.stringify(value)
  }
  return { api, raw, calls }
}
const searchReturning = (...items) => () => ({ total_count: items.length, items })
const limited = () => Object.assign(new Error('Command failed'), { stderr: 'gh: API rate limit exceeded for installation. (HTTP 403)\n' })

test('the search window starts an hour before the checkpoint and never reaches back past a week', () => {
  assert.equal(recentSince('2026-10-03T09:00:00Z', now), '2026-10-03T08:00:00Z')
  assert.equal(recentSince('2026-09-20T00:00:00Z', now), '2026-09-26T12:00:00Z')
  assert.equal(recentSince(null, now), '2026-09-26T12:00:00Z')
})

test('repository search pages through every query, filters by push time and merges repos case-insensitively', () => {
  const asked = []
  const pages = { 1: Array.from({ length: 100 }, (_, i) => repo(`owner/mod-${i}`)), 2: [repo('Owner/Mod-0'), repo('owner/extra', '2026-10-03T09:00:00Z', 'trunk')] }
  const request = (query, page) => {
    asked.push([query, page])
    return query.startsWith('topic:claude-code-mod ') ? { total_count: 102, items: pages[page] } : { total_count: 1, items: [repo('OWNER/MOD-1')] }
  }
  const found = searchRecent(since, request, quiet)
  assert.ok(asked.every(([query]) => query.endsWith(` pushed:>=${since}`)))
  assert.deepEqual(asked.filter(([query]) => query.startsWith('topic:claude-code-mod ')).map(([, page]) => page), [1, 2])
  assert.equal(asked.length, RECENT_QUERIES.length + 1)
  assert.equal(found.length, 101)
  assert.deepEqual(found.at(-1), { repo: 'owner/extra', branch: 'trunk', pushedAt: '2026-10-03T09:00:00Z' })
})

test('repository search stops at the GitHub result cap and says so', () => {
  const logs = []
  let requests = 0
  const request = (_, page) => { requests++; return { total_count: 5000, items: Array.from({ length: 100 }, (_, i) => repo(`o/r-${page}-${i}`)) } }
  searchRecent(since, request, { queries: ['topic:claude-code-plugin'], log: line => logs.push(line) })
  assert.equal(requests, 10)
  assert.match(logs[0], /matched 5000 repositories; checking the 1000 pushed most recently/)
  assert.throws(() => searchRecent('x', () => ({ total_count: 1, items: [{}] }), { queries: ['q'] }), /invalid search item/)
})

test('only a hooks.json in a hooks folder that lists modules makes a candidate, at one API call per repo', () => {
  const { api, raw, calls } = fakeGitHub({
    'a/mod': { 'plugins/x/hooks/hooks.json': { modules: ['./ui.ts'] } },
    'a/shell': { 'hooks/hooks.json': { hooks: { PreToolUse: [] } } },
    'a/vendored': { 'node_modules/pkg/hooks/hooks.json': { modules: ['x'] } },
    'a/wrong-folder': { 'config/hooks.json': { modules: ['x'] } },
    'a/empty': { 'hooks/hooks.json': { modules: [] } },
    'a/broken': { 'hooks/hooks.json': '{' },
    'a/huge': { truncated: true },
  })
  const check = name => hasHookModules({ repo: name, branch: 'main' }, api, raw)
  assert.deepEqual(['a/mod', 'a/shell', 'a/vendored', 'a/wrong-folder', 'a/empty', 'a/broken', 'a/huge'].map(check), [true, false, false, false, false, true, true])
  assert.equal(calls.length, 7)
  assert.equal(hasHookModules({ repo: 'a/mod', branch: 'main' }, api, () => { throw new Error('curl: (22) 404') }), true)
})

test('a search that does not finish keeps the checkpoint, and known repos are never checked', () => {
  const { api, raw, calls } = fakeGitHub({ 'new/mod': { 'hooks/hooks.json': { modules: ['m'] } } })
  const state = { searchedThrough: '2026-10-03T07:00:00Z', checked: {}, deferred: [{ repo: 'new/mod', branch: 'main', pushedAt: '2026-10-03T06:00:00Z' }] }
  const request = () => { throw new Error('repository search failed for topic:claude-code-mod: retry attempts exhausted') }
  const result = findRecent(since, ['known/mod'], { state, request, api, raw, startedAt: '2026-10-03T12:00:00Z', ...quiet })
  assert.equal(result.state.searchedThrough, '2026-10-03T07:00:00Z')
  assert.deepEqual(result.found, ['new/mod'])
  assert.equal(result.report.complete, false)
  assert.match(describeRecent(since, result)[0], /did not finish, so the checkpoint stays at 2026-10-03T07:00:00Z/)
  const ok = findRecent(since, ['known/mod'], { request: searchReturning(repo('Known/Mod')), api, raw, startedAt: '2026-10-03T12:00:00Z', ...quiet })
  assert.equal(ok.state.searchedThrough, '2026-10-03T12:00:00Z')
  assert.ok(!calls.some(path => path.startsWith('repos/Known')))
})

test('a repo past the check limit is deferred and checked first on the next run, even outside the window', () => {
  const nonMods = Array.from({ length: 3 }, (_, i) => repo(`plain/plugin-${i}`))
  const files = Object.fromEntries(nonMods.map(r => [r.full_name, { 'README.md': '' }]))
  files['late/mod'] = { 'hooks/hooks.json': { modules: ['m'] } }
  const { api, raw } = fakeGitHub(files)
  const first = findRecent(since, [], { request: searchReturning(...nonMods, repo('late/mod')), api, raw, limit: 3, startedAt: '2026-10-03T12:00:00Z', ...quiet })
  assert.deepEqual(first.found, [])
  assert.deepEqual(first.state.deferred.map(c => c.repo), ['late/mod'])
  assert.equal(Object.keys(first.state.checked).length, 3)
  assert.equal(first.state.searchedThrough, '2026-10-03T12:00:00Z')

  const asked = []
  const second = findRecent('2026-10-03T11:00:00Z', [], { state: first.state, request: q => { asked.push(q); return { total_count: 0, items: [] } }, api, raw, limit: 3, ...quiet })
  assert.deepEqual(second.found, ['late/mod'])
  assert.deepEqual(second.state.deferred, [])
  assert.ok(asked.length > 0)
})

test('a repo found not to be a mod is checked again only after a new push, and old entries are pruned', () => {
  const { api, raw, calls } = fakeGitHub({ 'plain/plugin': { 'README.md': '' } })
  const first = findRecent(since, [], { request: searchReturning(repo('plain/plugin', '2026-10-03T09:00:00Z')), api, raw, ...quiet })
  assert.deepEqual(first.state.checked, { 'plain/plugin': '2026-10-03T09:00:00Z' })
  findRecent(since, [], { state: first.state, request: searchReturning(repo('plain/plugin', '2026-10-03T09:00:00Z')), api, raw, ...quiet })
  assert.equal(calls.length, 1)
  findRecent(since, [], { state: first.state, request: searchReturning(repo('plain/plugin', '2026-10-03T11:00:00Z')), api, raw, ...quiet })
  assert.equal(calls.length, 2)
  const later = findRecent('2026-10-03T10:00:00Z', [], { state: first.state, request: searchReturning(), api, raw, ...quiet })
  assert.deepEqual(later.state.checked, {})
})

test('a rate limit stops checking and defers the rest; empty repos are not retried; other failures are', () => {
  const { api, raw, calls } = fakeGitHub({
    'gone/repo': Object.assign(new Error('Command failed'), { stderr: 'gh: Git Repository is empty. (HTTP 409)\n' }),
    'flaky/repo': new Error('socket hang up'),
    'limited/repo': limited(),
    'after/repo': { 'hooks/hooks.json': { modules: ['m'] } },
  })
  const logs = []
  const result = findRecent(since, [], { request: searchReturning(repo('gone/repo'), repo('flaky/repo'), repo('limited/repo'), repo('after/repo')), api, raw, log: line => logs.push(line) })
  assert.deepEqual(result.found, [])
  assert.deepEqual(result.state.deferred.map(c => c.repo), ['flaky/repo', 'limited/repo', 'after/repo'])
  assert.deepEqual(Object.keys(result.state.checked), ['gone/repo'])
  assert.equal(calls.length, 3)
  assert.equal(result.report.failed, 1)
  assert.match(result.report.stopped, /API rate limit exceeded/)
  assert.ok(logs.includes('skipped gone/repo: gh: Git Repository is empty. (HTTP 409)'))
  const lines = describeRecent(since, result)
  assert.match(lines[0], /matched 4 repositories; 4 needed a check, 3 were checked, 3 wait for the next run and 1 failed/)
  assert.match(lines[1], /Checking stopped at the API rate limit/)
})

test('the API budget caps checks below the limit and defers the rest', () => {
  const { api, raw, calls } = fakeGitHub({ 'a/one': { 'README.md': '' }, 'a/two': { 'README.md': '' } })
  const result = findRecent(since, [], { request: searchReturning(repo('a/one'), repo('a/two')), api, raw, limit: 200, budget: 1, ...quiet })
  assert.equal(calls.length, 1)
  assert.deepEqual(result.state.deferred.map(c => c.repo), ['a/two'])
})

test('scan metadata comes in GraphQL batches and missing repos fall back', () => {
  assert.match(metaQuery(['a/b', 'c/d.e']), /^query \{ r0: repository\(owner: "a", name: "b"\) \{ .* \} r1: repository\(owner: "c", name: "d.e"\)/)
  const queries = []
  const node = { stargazerCount: 5, pushedAt: 'p', createdAt: 'c', description: 'd', isArchived: true, licenseInfo: { spdxId: 'MIT' }, defaultBranchRef: { name: 'trunk' } }
  const metas = metaBatch(['A/one', 'a/missing', 'a/three'], { size: 2, log: () => {}, run: query => { queries.push(query); return queries.length === 1 ? { r0: node, r1: null } : { r0: { ...node, licenseInfo: null, defaultBranchRef: null } } } })
  assert.equal(queries.length, 2)
  assert.deepEqual(metas.get('a/one'), { stars: 5, pushedAt: 'p', createdAt: 'c', license: 'MIT', description: 'd', defaultBranch: 'trunk', archived: true })
  assert.equal(metas.has('a/missing'), false)
  assert.equal(metas.get('a/three').defaultBranch, null)
  assert.equal(metaBatch(['a/b'], { log: () => {}, run: () => { throw new Error('boom') } }).size, 0)
  assert.deepEqual(ghGraphql('q', () => { throw Object.assign(new Error('gh exit 1'), { stdout: '{"data":{"r0":null},"errors":[{"type":"NOT_FOUND"}]}' }) }), { r0: null })
})

function cli(t, gh, args, { state } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'discovery-cli-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'data'))
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'data/repos.txt'), 'existing/mod\n')
  writeFileSync(join(root, 'data/seeds.txt'), 'seeded/mod\n')
  writeFileSync(join(root, 'data/mods.json'), JSON.stringify({ generated: new Date(Date.now() - 2 * HOUR).toISOString(), mods: [] }))
  if (state) writeFileSync(join(root, 'data/discovery.json'), JSON.stringify(state))
  const binary = (name, code) => { writeFileSync(join(root, 'bin', name), '#!' + process.execPath + '\n' + code); chmodSync(join(root, 'bin', name), 0o755) }
  binary('gh', gh)
  binary('curl', `const url = process.argv.at(-1); if (url.includes('/fresh/mod/')) console.log('{"modules":["./m.ts"]}'); else process.exit(22)`)
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./discover.mjs', import.meta.url)), ...args, '--note', join(root, 'note.txt')], {
    cwd: root, env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH, GH_LOG: join(root, 'gh.log') }, encoding: 'utf8', timeout: 60000,
  })
  const read = name => { try { return readFileSync(join(root, name), 'utf8') } catch { return '' } }
  return { run, repos: read('data/repos.txt'), note: read('note.txt'), gh: read('gh.log'), state: read('data/discovery.json') }
}

const limitedGh = `
require('node:fs').appendFileSync(process.env.GH_LOG, process.argv.slice(2).join(' ') + '\\n')
console.log('HTTP/2.0 429 Too Many Requests\\nRetry-After: 1801\\n\\n{"message":"slow down"}'); process.exit(1)
`

test('a rate-limited code search keeps known candidates and seeds when asked to', t => {
  const { run, repos, note } = cli(t, limitedGh, ['--keep-on-failure'])
  assert.equal(run.status, 0, run.stderr)
  assert.equal(repos, 'existing/mod\nseeded/mod\n')
  assert.match(note, /^Code search did not finish, so discovery kept the known candidates and seeds\. code search failed/)
})

test('a fast refresh skips code search, adds recent repos with hook modules and saves its progress', t => {
  const gh = `
const fs = require('node:fs'), args = process.argv.slice(2)
fs.appendFileSync(process.env.GH_LOG, args.join(' ') + '\\n')
const json = value => console.log(JSON.stringify(value))
if (args.includes('search/code')) { console.log('HTTP/2.0 500 Internal\\n\\n{"message":"code search must not run"}'); process.exit(1) }
if (args.includes('rate_limit')) console.log(5000)
else if (args.includes('search/repositories')) {
  console.log('HTTP/2.0 200 OK\\n\\n' + JSON.stringify({ total_count: 3, incomplete_results: false, items: [
    { full_name: 'fresh/mod', default_branch: 'main', pushed_at: '2026-10-03T09:00:00Z' },
    { full_name: 'fresh/plugin', default_branch: 'main', pushed_at: '2026-10-03T09:30:00Z' },
    { full_name: 'Existing/Mod', default_branch: 'main', pushed_at: '2026-10-03T09:00:00Z' } ] }))
} else if (args[1].startsWith('repos/fresh/mod/git/trees/')) json({ truncated: false, tree: [{ type: 'blob', path: 'hooks/hooks.json' }] })
else if (args[1].startsWith('repos/fresh/plugin/git/trees/')) json({ truncated: false, tree: [{ type: 'blob', path: 'README.md' }] })
else process.exit(1)
`
  const state = { searchedThrough: '2026-10-03T09:00:00Z', checked: {}, deferred: [] }
  const before = Date.now()
  const { run, repos, note, gh: log, state: saved } = cli(t, gh, ['--skip-code-search', '--recent'], { state })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(repos, 'existing/mod\nfresh/mod\nseeded/mod\n')
  assert.ok(!log.includes('search/code'))
  assert.ok(log.includes('sort=updated'))
  assert.ok(log.includes('q=topic:claude-code-mod pushed:>=2026-10-03T08:00:00Z'))
  assert.match(note, /^Code search was skipped; this run covers known candidates and seeds\.\nRepository search since 2026-10-03T08:00:00Z matched 3 repositories; 2 needed a check, 2 were checked, 0 wait for the next run and 0 failed\.\nAdded fresh\/mod\.\n$/)
  const progress = JSON.parse(saved)
  assert.ok(Date.parse(progress.searchedThrough) >= before - 1000)
  assert.deepEqual(progress.checked, { 'fresh/plugin': '2026-10-03T09:30:00Z' })
  assert.deepEqual(progress.deferred, [])
})

test('a failed repository search still writes the known candidates and keeps the checkpoint', t => {
  const state = { searchedThrough: '2026-10-03T09:00:00Z', checked: {}, deferred: [] }
  const { run, repos, note, state: saved } = cli(t, limitedGh, ['--skip-code-search', '--recent'], { state })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(repos, 'existing/mod\nseeded/mod\n')
  assert.match(note, /Repository search did not finish, so the checkpoint stays at 2026-10-03T09:00:00Z\. repository search failed for topic:claude-code-mod/)
  assert.equal(JSON.parse(saved).searchedThrough, '2026-10-03T09:00:00Z')
})
