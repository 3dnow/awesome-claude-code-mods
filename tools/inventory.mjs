export function reconcile(previous, current, checkedRepos, retire = false) {
  const ids = new Set(current.map(mod => mod.id))
  const kept = [...current], retired = []
  for (const mod of previous) {
    if (ids.has(mod.id)) continue
    const revision = checkedRepos.get(mod.repo.toLowerCase())
    if (retire && revision) {
      retired.push({ id: mod.id, repo: mod.repo, revision, reason: 'hook module no longer present in a fresh checkout' })
      continue
    }
    kept.push({
      ...mod,
      lastKnownValidate: mod.lastKnownValidate ?? mod.validate,
      validate: {
        status: 'unknown', claudeVersion: mod.validate.claudeVersion,
        errors: [revision ? 'Not found in this scan; retained pending weekly retirement review.' : 'Repository could not be scanned; showing the last known footprint.'],
      },
    })
  }
  return { mods: kept, retired }
}

export function checkRequired(repos, mods, checkedRepos) {
  for (const repo of repos) {
    const matches = mods.filter(mod => mod.repo.toLowerCase() === repo.toLowerCase() && mod.kind === 'mod')
    if (!checkedRepos.has(repo.toLowerCase()) || !matches.length || matches.some(mod => !['passed', 'warnings'].includes(mod.validate.status))) {
      throw new Error(`new seed ${repo} must clone successfully and contain validating mod plugins`)
    }
  }
}
