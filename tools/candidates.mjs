import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'

export function parseRepos(text) {
  return text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
}

export function readRepos(path) {
  try { return parseRepos(readFileSync(path, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

export function mergeRepos(...lists) {
  const repos = new Map()
  for (const repo of lists.flat()) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`invalid repository: ${repo}`)
    if (!repos.has(repo.toLowerCase())) repos.set(repo.toLowerCase(), repo)
  }
  return [...repos.values()].sort((a, b) => a.localeCompare(b))
}

export function newSeeds(before, after) {
  const known = new Set(before.map(repo => repo.toLowerCase()))
  return mergeRepos(after).filter(repo => !known.has(repo.toLowerCase()))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { base: { type: 'string' } } })
  if (!values.base || !/^[a-f0-9]{40}$/.test(values.base)) throw new Error('a full PR base commit is required')
  const seeds = readRepos('data/seeds.txt')
  const before = parseRepos(execFileSync('git', ['show', `${values.base}:data/seeds.txt`], { encoding: 'utf8' }))
  writeFileSync('data/pr-repos.txt', mergeRepos(readRepos('data/repos.txt'), seeds).join('\n') + '\n')
  writeFileSync('data/pr-required.txt', newSeeds(before, seeds).join('\n') + '\n')
}
