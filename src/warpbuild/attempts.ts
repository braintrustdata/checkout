/* eslint-disable i18n-text/no-en, import/no-unresolved -- upstream conventions; no TS import resolver configured */
import * as core from '@actions/core'
import * as gitTrace from './git-trace.js'
import * as path from 'path'
import {ChildProcess, spawn, spawnSync} from 'child_process'

// Runs each checkout attempt in a child process so a hung git command can be
// killed, together with everything it spawned, once the attempt times out.

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_TIMEOUT_MINUTES = 10
const RETRY_MIN_SECONDS = 10
const RETRY_MAX_SECONDS = 20
export const ATTEMPT_VARIABLE = 'WARPBUILD_CHECKOUT_ATTEMPT'

export type AttemptOutcome = 'success' | 'failure' | 'timeout'

export interface AttemptSettings {
  maxAttempts: number
  timeoutMinutes: number
}

export interface AttemptResult {
  attempt: number
  outcome: AttemptOutcome
  duration_seconds: number
  traced: boolean
}

export interface ChildAttempt {
  attempt: number
  maxAttempts: number
}

export interface RunOptions {
  command: string[]
  thresholdSeconds: number
  secrets: string[]
  now?: () => number
  sleep?: (seconds: number) => Promise<void>
}

function parseInput(
  name: string,
  defaultValue: number,
  isValid: (value: number) => boolean,
  expected: string
): number {
  const input = core.getInput(name)
  if (!input) {
    return defaultValue
  }
  const value = Number(input)
  if (!isValid(value)) {
    throw new Error(`Invalid ${name} '${input}'. Expected ${expected}.`)
  }
  return value
}

export function getSettings(): AttemptSettings {
  return {
    maxAttempts: parseInput(
      'max-attempts',
      DEFAULT_MAX_ATTEMPTS,
      value => Number.isInteger(value) && value >= 1,
      'a positive integer'
    ),
    timeoutMinutes: parseInput(
      'attempt-timeout-minutes',
      DEFAULT_TIMEOUT_MINUTES,
      value => Number.isFinite(value) && value >= 0,
      'a non-negative number'
    )
  }
}

export function childAttempt(): ChildAttempt | undefined {
  const match = /^(\d+)\/(\d+)$/.exec(process.env[ATTEMPT_VARIABLE] || '')
  if (!match) {
    return undefined
  }
  return {attempt: Number(match[1]), maxAttempts: Number(match[2])}
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    return
  }
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'])
    } else {
      process.kill(-child.pid, 'SIGKILL')
    }
  } catch (error) {
    core.warning(
      `Failed to kill checkout attempt: ${error instanceof Error ? error.message : error}`
    )
  }
}

export async function runChild(
  command: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<AttemptOutcome> {
  return new Promise(resolve => {
    const child = spawn(command[0], command.slice(1), {
      env,
      stdio: 'inherit',
      detached: process.platform !== 'win32'
    })
    let timedOut = false
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            killTree(child)
          }, timeoutMs)
        : undefined
    const forward = (): void => {
      killTree(child)
      process.exit(1)
    }
    process.once('SIGINT', forward)
    process.once('SIGTERM', forward)
    const settle = (outcome: AttemptOutcome): void => {
      clearTimeout(timer)
      process.removeListener('SIGINT', forward)
      process.removeListener('SIGTERM', forward)
      resolve(timedOut ? 'timeout' : outcome)
    }
    child.once('error', error => {
      core.warning(`Failed to start checkout attempt: ${error.message}`)
      settle('failure')
    })
    child.once('exit', code => settle(code === 0 ? 'success' : 'failure'))
  })
}

async function sleepSeconds(seconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000))
}

export async function run(
  settings: AttemptSettings,
  options: RunOptions
): Promise<AttemptResult[]> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? sleepSeconds
  gitTrace.clearExports()
  const output = gitTrace.newOutput()
  const results: AttemptResult[] = []
  for (let attempt = 1; attempt <= settings.maxAttempts; attempt++) {
    const trace = gitTrace.start(options.thresholdSeconds, now)
    const startedAt = now()
    const outcome = await runChild(
      options.command,
      {
        ...process.env,
        [ATTEMPT_VARIABLE]: `${attempt}/${settings.maxAttempts}`
      },
      settings.timeoutMinutes * 60_000
    )
    const durationSeconds = Math.round((now() - startedAt) / 1000)
    const traced =
      output !== undefined &&
      (await gitTrace.finish(
        trace,
        options.secrets,
        path.join(output.directory, `attempt-${attempt}`),
        now
      ))
    results.push({attempt, outcome, duration_seconds: durationSeconds, traced})
    if (outcome === 'success') {
      break
    }
    const reason =
      outcome === 'timeout'
        ? `timed out after ${settings.timeoutMinutes} minutes`
        : 'failed'
    if (attempt === settings.maxAttempts) {
      core.setFailed(
        `Checkout attempt ${attempt}/${settings.maxAttempts} ${reason}; giving up`
      )
      break
    }
    const seconds =
      Math.floor(Math.random() * (RETRY_MAX_SECONDS - RETRY_MIN_SECONDS + 1)) +
      RETRY_MIN_SECONDS
    core.warning(
      `Checkout attempt ${attempt}/${settings.maxAttempts} ${reason}; retrying in ${seconds} seconds`
    )
    await sleep(seconds)
  }
  if (output !== undefined && results.some(result => result.traced)) {
    gitTrace.publish(output, {
      max_attempts: settings.maxAttempts,
      attempt_timeout_minutes: settings.timeoutMinutes,
      threshold_seconds: options.thresholdSeconds,
      attempts: results
    })
  }
  return results
}
