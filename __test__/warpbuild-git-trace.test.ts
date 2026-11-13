import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  ARTIFACT_VARIABLE,
  DIRECTORY_VARIABLE,
  finish,
  getThresholdSeconds,
  redactor,
  start
} from '../src/warpbuild/git-trace.js'

const traceVariables = [
  'GIT_TRACE',
  'GIT_TRACE_PACKET',
  'GIT_TRACE_CURL',
  'GIT_TRACE_CURL_NO_DATA',
  'GIT_TRACE2_PERF',
  'GIT_TRACE2_EVENT'
]
const managedVariables = [
  ...traceVariables,
  'RUNNER_TEMP',
  'GITHUB_JOB',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_ENV',
  ARTIFACT_VARIABLE,
  DIRECTORY_VARIABLE,
  'INPUT_GIT-TRACE-THRESHOLD-SECONDS'
]
const savedEnv = new Map(managedVariables.map(key => [key, process.env[key]]))

describe('git-trace', () => {
  let runnerTemp: string

  beforeEach(() => {
    for (const key of managedVariables) {
      delete process.env[key]
    }
    runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-git-trace-'))
    process.env['RUNNER_TEMP'] = runnerTemp
    process.env['GITHUB_JOB'] = 'frontend verify'
    process.env['GITHUB_RUN_ATTEMPT'] = '2'
    process.env['GITHUB_ENV'] = path.join(runnerTemp, 'github-env')
    fs.writeFileSync(process.env['GITHUB_ENV'], '')
  })

  afterEach(() => {
    fs.rmSync(runnerTemp, {recursive: true, force: true})
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  it('parses the threshold input', () => {
    expect(getThresholdSeconds()).toBe(180)
    process.env['INPUT_GIT-TRACE-THRESHOLD-SECONDS'] = '0'
    expect(getThresholdSeconds()).toBe(0)
    process.env['INPUT_GIT-TRACE-THRESHOLD-SECONDS'] = '-1'
    expect(() => getThresholdSeconds()).toThrow(/git-trace-threshold-seconds/)
  })

  it('is disabled with a zero threshold', () => {
    expect(start(0)).toBeUndefined()
    expect(process.env['GIT_TRACE']).toBeUndefined()
  })

  it('saves redacted traces when the checkout is slow', async () => {
    let clock = 1_000
    const trace = start(180, () => clock)
    expect(trace).toBeDefined()
    expect(process.env['GIT_TRACE_CURL_NO_DATA']).toBe('1')
    expect(path.dirname(process.env['GIT_TRACE2_EVENT'] as string)).toBe(
      trace?.directory
    )
    const basic = Buffer.from('x-access-token:ghs_secret').toString('base64')
    fs.writeFileSync(
      process.env['GIT_TRACE'] as string,
      `git config extraheader 'AUTHORIZATION: basic ${basic}'\ngit fetch https://user:ghs_secret@example.com/repo\n`
    )
    fs.writeFileSync(process.env['GIT_TRACE2_EVENT'] as string, '{}\n')

    clock += 181_000
    await finish(trace, ['ghs_secret'], () => clock)

    const outputDirectory = process.env[DIRECTORY_VARIABLE] as string
    expect(path.dirname(outputDirectory)).toBe(
      path.join(runnerTemp, 'checkout-git-traces')
    )
    expect(process.env[ARTIFACT_VARIABLE]).toBe(
      `checkout-git-trace-frontend-verify-attempt-2-${path.basename(outputDirectory)}`
    )
    expect(fs.readdirSync(outputDirectory).sort()).toEqual([
      'trace.log',
      'trace2-event.json'
    ])
    expect(
      fs.readFileSync(path.join(outputDirectory, 'trace.log'), 'utf8')
    ).toBe(
      "git config extraheader 'AUTHORIZATION: basic ***'\ngit fetch https://user:***@example.com/repo\n"
    )
    const githubEnv = fs.readFileSync(
      process.env['GITHUB_ENV'] as string,
      'utf8'
    )
    expect(githubEnv).toContain(ARTIFACT_VARIABLE)
    expect(githubEnv).toContain(outputDirectory)
    for (const key of traceVariables) {
      expect(process.env[key]).toBeUndefined()
    }
    expect(fs.existsSync(trace?.directory as string)).toBe(false)
  })

  it('discards traces when the checkout is fast', async () => {
    let clock = 1_000
    const trace = start(180, () => clock)
    fs.writeFileSync(process.env['GIT_TRACE'] as string, 'trace')

    clock += 180_000
    await finish(trace, [], () => clock)

    expect(process.env[ARTIFACT_VARIABLE]).toBeUndefined()
    expect(fs.existsSync(path.join(runnerTemp, 'checkout-git-traces'))).toBe(
      false
    )
    expect(fs.existsSync(trace?.directory as string)).toBe(false)
  })

  it('clears traces exported by an earlier checkout', () => {
    process.env[ARTIFACT_VARIABLE] = 'previous'
    process.env[DIRECTORY_VARIABLE] = '/previous'
    start(180)
    expect(process.env[ARTIFACT_VARIABLE]).toBe('')
    expect(process.env[DIRECTORY_VARIABLE]).toBe('')
  })

  it('keeps trace variables set by the workflow', async () => {
    process.env['GIT_TRACE'] = '1'
    const trace = start(180)
    expect(process.env['GIT_TRACE']).toBe('1')
    await finish(trace, [])
    expect(process.env['GIT_TRACE']).toBe('1')
  })

  it('does not fail the checkout when saving traces fails', async () => {
    let clock = 1_000
    const trace = start(1, () => clock)
    fs.writeFileSync(process.env['GIT_TRACE'] as string, 'trace')
    fs.writeFileSync(path.join(runnerTemp, 'checkout-git-traces'), '')
    clock += 2_000
    await expect(finish(trace, [], () => clock)).resolves.toBeUndefined()
    expect(process.env[ARTIFACT_VARIABLE]).toBeUndefined()
    expect(fs.existsSync(trace?.directory as string)).toBe(false)
  })

  it('ignores short secrets', () => {
    expect(redactor(['', 'abc'])('abc')).toBe('abc')
  })
})
