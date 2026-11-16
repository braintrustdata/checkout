import {afterEach, beforeEach, describe, expect, it} from '@jest/globals'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  ATTEMPT_VARIABLE,
  childAttempt,
  getSettings,
  run
} from '../src/warpbuild/attempts.js'
import {
  ARTIFACT_VARIABLE,
  ATTEMPTS_FILE,
  DIRECTORY_VARIABLE
} from '../src/warpbuild/git-trace.js'

const managedVariables = [
  'RUNNER_TEMP',
  'GITHUB_JOB',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_ENV',
  ATTEMPT_VARIABLE,
  ARTIFACT_VARIABLE,
  DIRECTORY_VARIABLE,
  'INPUT_MAX-ATTEMPTS',
  'INPUT_ATTEMPT-TIMEOUT-MINUTES'
]
const savedEnv = new Map(managedVariables.map(key => [key, process.env[key]]))
const noSleep = async (): Promise<void> => {}

function node(script: string): string[] {
  return [process.execPath, '-e', script]
}

describe('attempts', () => {
  let runnerTemp: string

  beforeEach(() => {
    for (const key of managedVariables) {
      delete process.env[key]
    }
    runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-attempts-'))
    process.env['RUNNER_TEMP'] = runnerTemp
    process.env['GITHUB_JOB'] = 'build'
    process.env['GITHUB_ENV'] = path.join(runnerTemp, 'github-env')
    fs.writeFileSync(process.env['GITHUB_ENV'], '')
  })

  afterEach(() => {
    process.exitCode = undefined
    fs.rmSync(runnerTemp, {recursive: true, force: true})
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  it('parses the attempt inputs', () => {
    expect(getSettings()).toEqual({maxAttempts: 3, timeoutMinutes: 10})
    process.env['INPUT_MAX-ATTEMPTS'] = '1'
    process.env['INPUT_ATTEMPT-TIMEOUT-MINUTES'] = '0'
    expect(getSettings()).toEqual({maxAttempts: 1, timeoutMinutes: 0})
    process.env['INPUT_MAX-ATTEMPTS'] = '0'
    expect(() => getSettings()).toThrow(/max-attempts/)
    process.env['INPUT_MAX-ATTEMPTS'] = '1'
    process.env['INPUT_ATTEMPT-TIMEOUT-MINUTES'] = '-1'
    expect(() => getSettings()).toThrow(/attempt-timeout-minutes/)
  })

  it('reads the attempt of a child process', () => {
    expect(childAttempt()).toBeUndefined()
    process.env[ATTEMPT_VARIABLE] = '2/3'
    expect(childAttempt()).toEqual({attempt: 2, maxAttempts: 3})
  })

  it('stops after a successful attempt', async () => {
    const results = await run(
      {maxAttempts: 3, timeoutMinutes: 1},
      {command: node('process.exit(0)'), thresholdSeconds: 180, secrets: []}
    )
    expect(results).toEqual([
      expect.objectContaining({attempt: 1, outcome: 'success', traced: false})
    ])
    expect(process.env[ARTIFACT_VARIABLE]).toBeUndefined()
    expect(process.exitCode).toBeUndefined()
  })

  it('retries failed attempts and exports traces of slow ones', async () => {
    const script = `
      const fs = require('fs')
      const attempt = process.env.${ATTEMPT_VARIABLE}
      fs.writeFileSync(process.env.GIT_TRACE, 'attempt ' + attempt + ' token ghs_secret\\n')
      if (attempt === '1/3') setTimeout(() => process.exit(1), 300)
      else process.exit(0)
    `
    const results = await run(
      {maxAttempts: 3, timeoutMinutes: 1},
      {
        command: node(script),
        thresholdSeconds: 0.2,
        secrets: ['ghs_secret'],
        sleep: noSleep
      }
    )

    expect(results.map(result => [result.outcome, result.traced])).toEqual([
      ['failure', true],
      ['success', false]
    ])
    const directory = process.env[DIRECTORY_VARIABLE] as string
    expect(process.env[ARTIFACT_VARIABLE]).toMatch(
      /^checkout-git-trace-build-attempt-1-/
    )
    expect(fs.readdirSync(directory).sort()).toEqual([
      'attempt-1',
      ATTEMPTS_FILE
    ])
    expect(
      fs.readFileSync(path.join(directory, 'attempt-1', 'trace.log'), 'utf8')
    ).toBe('attempt 1/3 token ***\n')
    expect(
      JSON.parse(fs.readFileSync(path.join(directory, ATTEMPTS_FILE), 'utf8'))
    ).toEqual({
      max_attempts: 3,
      attempt_timeout_minutes: 1,
      threshold_seconds: 0.2,
      attempts: results
    })
    expect(process.exitCode).toBeUndefined()
  })

  it('kills timed out attempts and their children, then fails', async () => {
    const pidFile = path.join(runnerTemp, 'pids')
    const script = `
      const {spawn} = require('child_process')
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
      require('fs').appendFileSync(${JSON.stringify(pidFile)}, child.pid + '\\n')
      setInterval(() => {}, 1000)
    `
    const results = await run(
      {maxAttempts: 2, timeoutMinutes: 0.01},
      {
        command: node(script),
        thresholdSeconds: 0.1,
        secrets: [],
        sleep: noSleep
      }
    )

    expect(results.map(result => result.outcome)).toEqual([
      'timeout',
      'timeout'
    ])
    expect(process.exitCode).toBe(1)
    const pids = fs.readFileSync(pidFile, 'utf8').trim().split('\n')
    expect(pids).toHaveLength(2)
    for (const pid of pids) {
      expect(() => process.kill(Number(pid), 0)).toThrow()
    }
    expect(process.env[ARTIFACT_VARIABLE]).toBeUndefined()
  })
})
