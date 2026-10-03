import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recentSince, searchRecent, hasHookModules, findRecent, RECENT_QUERIES } from './recent.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOUR = 3600 * 1000
const now = Date.parse('2026-10-03T12:00:00Z')
const repo = (name, branch = 'main') => ({ full_name: name, default_branch: branch })
const encode = value => ({ content: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64') })

function fakeApi(files) {
  const calls = []
  const api = path => {
    calls.push(path)
    const tree = /^repos\/(.+?)\/git\/trees\/([^?]+)\?recursive=1$/.exec(path)
    if (tree) {
      const entry = files[tree[1]]
      if (!entry) throw new Error('HTTP 404: Not Found')
      return entry.truncated ? { truncated: true, tree: [] } : { truncated: false, tree: Object.keys(entry).map(p => ({ type: 'blob', path: p })) }
    }
    const content = /^repos\/(.+?\/.+?)\/contents\/(.+)\?ref=/.exec(path)
    return encode(files[content[1]][decodeURIComponent(content[2])])
  }
  return { api, calls }
}

test('the search window starts an hour before the last scan and never reaches back past two days', () => {
  assert.equal(recentSince('2026-10-03T09:00:00Z', now), '2026-10-03T08:00:00Z')
  assert.equal(recentSince('2026-09-20T00:00:00Z', now), '2026-10-01T12:00:00Z')
  assert.equal(recentSince(null, now), '2026-10-01T12:00:00Z')
  assert.equal(recentSince('not a date', now - HOUR), '2026-10-01T11:00:00Z')
})

test('repository search pages through every query, filters by push time and merges repos case-insensitively', () => {
  const asked = []
  const pages = { 1: Array.from({ length: 100 }, (_, i) => repo(`owner/mod-${i}`)), 2: [repo('Owner/Mod-0'), repo('owner/extra', 'trunk')] }
  const request = (query, page) => {
    asked.push([query, page])
    return query.startsWith('topic:claude-code-mod ') ? { total_count: 102, items: pages[page] } : { total_count: 1, items: [repo('OWNER/MOD-1')] }
  }
  const found = searchRecent('2026-10-03T08:00:00Z', request, { log: () => {} })
  assert.ok(asked.every(([query]) => query.endsWith(' pushed:>=2026-10-03T08:00:00Z')))
  assert.deepEqual(asked.filter(([query]) => query.startsWith('topic:claude-code-mod ')).map(([, page]) => page), [1, 2])
  assert.equal(asked.length, RECENT_QUERIES.length + 1)
  assert.equal(found.length, 101)
  assert.deepEqual(found.at(-1), { repo: 'owner/extra', branch: 'trunk' })
})

test('repository search stops at GitHub result cap and says so', () => {
  const logs = []
  let requests = 0
  const request = (_, page) => { requests++; return { total_count: 5000, items: Array.from({ length: 100 }, (_, i) => repo(`o/r-${page}-${i}`)) } }
  searchRecent('2026-10-03T08:00:00Z', request, { queries: ['topic:claude-code-plugin'], log: line => logs.push(line) })
  assert.equal(requests, 10)
  assert.match(logs[0], /matched 5000 repositories; checking the 1000 pushed most recently/)
  assert.throws(() => searchRecent('x', () => ({ total_count: 1, items: [{}] }), { queries: ['q'] }), /invalid search item/)
})

test('only a hooks.json in a hooks folder that lists modules makes a candidate', () => {
  const { api, calls } = fakeApi({
    'a/mod': { 'plugins/x/hooks/hooks.json': { modules: ['./ui.ts'] } },
    'a/shell': { 'hooks/hooks.json': { hooks: { PreToolUse: [] } } },
    'a/vendored': { 'node_modules/pkg/hooks/hooks.json': { modules: ['x'] } },
    'a/wrong-folder': { 'config/hooks.json': { modules: ['x'] } },
    'a/empty': { 'hooks/hooks.json': { modules: [] } },
    'a/broken': { 'hooks/hooks.json': '{' },
    'a/huge': { truncated: true },
  })
  assert.equal(hasHookModules({ repo: 'a/mod', branch: 'main' }, api), true)
  assert.equal(hasHookModules({ repo: 'a/shell', branch: 'main' }, api), false)
  assert.equal(hasHookModules({ repo: 'a/vendored', branch: 'main' }, api), false)
  assert.equal(hasHookModules({ repo: 'a/wrong-folder', branch: 'main' }, api), false)
  assert.equal(hasHookModules({ repo: 'a/empty', branch: 'main' }, api), false)
  assert.equal(hasHookModules({ repo: 'a/broken', branch: 'main' }, api), true)
  assert.equal(hasHookModules({ repo: 'a/huge', branch: 'main' }, api), true)
  assert.ok(!calls.some(path => path.includes('/contents/node_modules') || path.includes('/contents/config')))
})

test('known repos are never re-checked, the check limit is logged and one failing repo does not stop the rest', () => {
  const { api, calls } = fakeApi({ 'new/mod': { 'hooks/hooks.json': { modules: ['m'] } }, 'new/other': { 'hooks/hooks.json': { modules: ['m'] } } })
  const logs = []
  const request = () => ({ total_count: 4, items: [repo('Known/Mod'), repo('gone/repo'), repo('new/mod'), repo('new/other')] })
  const found = findRecent('2026-10-03T08:00:00Z', ['known/mod'], { request, api, limit: 2, log: line => logs.push(line) })
  assert.deepEqual(found, ['new/mod'])
  assert.ok(!calls.some(path => path.startsWith('repos/Known/Mod')))
  assert.ok(!calls.some(path => path.startsWith('repos/new/other')))
  assert.ok(logs.some(line => /checking 2 of 3 new repositories/.test(line)))
  assert.ok(logs.some(line => /skipped gone\/repo: HTTP 404/.test(line)))
  const failing = () => { throw Object.assign(new Error('Command failed: gh api repos/empty/repo'), { stderr: 'gh: Git Repository is empty. (HTTP 409)\n' }) }
  findRecent('2026-10-03T08:00:00Z', [], { request: () => ({ total_count: 1, items: [repo('empty/repo')] }), api: failing, log: line => logs.push(line) })
  assert.equal(logs.at(-1), 'skipped empty/repo: gh: Git Repository is empty. (HTTP 409)')
})

function cli(t, gh, args) {
  const root = mkdtempSync(join(tmpdir(), 'discovery-cli-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'data'))
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'data/repos.txt'), 'existing/mod\n')
  writeFileSync(join(root, 'data/seeds.txt'), 'seeded/mod\n')
  writeFileSync(join(root, 'data/mods.json'), JSON.stringify({ generated: new Date(Date.now() - 2 * HOUR).toISOString(), mods: [] }))
  writeFileSync(join(root, 'bin/gh'), '#!' + process.execPath + '\n' + gh)
  chmodSync(join(root, 'bin/gh'), 0o755)
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./discover.mjs', import.meta.url)), ...args, '--note', join(root, 'note.txt')], {
    cwd: root, env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH, GH_LOG: join(root, 'gh.log') }, encoding: 'utf8', timeout: 60000,
  })
  const read = name => { try { return readFileSync(join(root, name), 'utf8') } catch { return '' } }
  return { run, repos: read('data/repos.txt'), note: read('note.txt'), gh: read('gh.log') }
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

test('a fast refresh skips code search and adds recently pushed repos that hold hook modules', t => {
  const gh = `
const fs = require('node:fs'), args = process.argv.slice(2)
fs.appendFileSync(process.env.GH_LOG, args.join(' ') + '\\n')
const json = value => console.log(JSON.stringify(value))
if (args.includes('search/code')) { console.log('HTTP/2.0 500 Internal\\n\\n{"message":"code search must not run"}'); process.exit(1) }
if (args.includes('search/repositories')) {
  console.log('HTTP/2.0 200 OK\\n\\n' + JSON.stringify({ total_count: 3, incomplete_results: false, items: [
    { full_name: 'fresh/mod', default_branch: 'main' }, { full_name: 'fresh/plugin', default_branch: 'main' }, { full_name: 'Existing/Mod', default_branch: 'main' } ] }))
} else if (args[1].startsWith('repos/fresh/mod/git/trees/')) json({ truncated: false, tree: [{ type: 'blob', path: 'hooks/hooks.json' }] })
else if (args[1].startsWith('repos/fresh/plugin/git/trees/')) json({ truncated: false, tree: [{ type: 'blob', path: 'README.md' }] })
else if (args[1].startsWith('repos/fresh/mod/contents/hooks/hooks.json')) json({ content: Buffer.from('{"modules":["./m.ts"]}').toString('base64') })
else process.exit(1)
`
  const { run, repos, note, gh: log } = cli(t, gh, ['--skip-code-search', '--recent', '--since', '2026-10-03T08:00:00Z'])
  assert.equal(run.status, 0, run.stderr)
  assert.equal(repos, 'existing/mod\nfresh/mod\nseeded/mod\n')
  assert.ok(!log.includes('search/code'))
  assert.ok(log.includes('sort=updated'))
  assert.ok(log.includes('q=topic:claude-code-mod pushed:>=2026-10-03T08:00:00Z'))
  assert.equal(note, 'Code search was skipped; this run covers known candidates and seeds.\nRepository search since 2026-10-03T08:00:00Z added fresh/mod.\n')
})

test('a failed repository search still writes the known candidates and seeds', t => {
  const { run, repos, note } = cli(t, limitedGh, ['--skip-code-search', '--recent', '--since', '2026-10-03T08:00:00Z'])
  assert.equal(run.status, 0, run.stderr)
  assert.equal(repos, 'existing/mod\nseeded/mod\n')
  assert.match(note, /Repository search did not finish\. repository search failed for topic:claude-code-mod/)
})
