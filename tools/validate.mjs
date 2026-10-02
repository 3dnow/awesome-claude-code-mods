import { spawnSync } from 'node:child_process'
import { parseValidateOutput } from './parse.mjs'

export function validate(path, cwd) {
  const result = spawnSync('claude', ['plugin', 'validate', path], { cwd, encoding: 'utf8', timeout: 60000 })
  const parsed = parseValidateOutput((result.stdout ?? '') + (result.stderr ?? ''))
  if (result.error || result.signal || (result.status !== 0 && parsed.status !== 'failed')) {
    parsed.status = 'unknown'
    parsed.errors.push(result.error?.code ?? (result.signal ? `Validator terminated by ${result.signal}` : `Validator exited with status ${result.status}`))
  }
  return parsed
}
