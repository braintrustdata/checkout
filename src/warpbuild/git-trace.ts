/* eslint-disable i18n-text/no-en -- upstream conventions */
import * as core from '@actions/core'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'

// Native git tracing for every checkout. When the whole checkout exceeds the
// threshold, the redacted traces are moved to OUTPUT_DIRECTORY under
// RUNNER_TEMP and exported through the CHECKOUT_GIT_TRACE_* environment
// variables so a later workflow step can upload them.

const DEFAULT_THRESHOLD_SECONDS = 180
export const OUTPUT_DIRECTORY = 'checkout-git-traces'
export const DIRECTORY_VARIABLE = 'CHECKOUT_GIT_TRACE_DIR'
export const ARTIFACT_VARIABLE = 'CHECKOUT_GIT_TRACE_ARTIFACT'

const TRACE_FILES: Record<string, string> = {
  GIT_TRACE: 'trace.log',
  GIT_TRACE_PACKET: 'trace-packet.log',
  GIT_TRACE_CURL: 'trace-curl.log',
  GIT_TRACE2_PERF: 'trace2-perf.log',
  GIT_TRACE2_EVENT: 'trace2-event.json'
}

export interface GitTrace {
  directory: string
  thresholdSeconds: number
  startedAt: number
  setVariables: string[]
}

export function getThresholdSeconds(): number {
  const input = core.getInput('git-trace-threshold-seconds')
  if (!input) {
    return DEFAULT_THRESHOLD_SECONDS
  }
  const value = Number(input)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `Invalid git-trace-threshold-seconds '${input}'. Expected a non-negative number.`
    )
  }
  return value
}

export function start(
  thresholdSeconds: number,
  now: () => number = Date.now
): GitTrace | undefined {
  const runnerTemp = process.env['RUNNER_TEMP']
  if (thresholdSeconds <= 0 || !runnerTemp) {
    return undefined
  }

  // Only describe the most recent checkout, so an upload step after a fast
  // checkout does not re-upload an earlier checkout's traces.
  if (process.env[ARTIFACT_VARIABLE]) {
    core.exportVariable(ARTIFACT_VARIABLE, '')
    core.exportVariable(DIRECTORY_VARIABLE, '')
  }

  const directory = path.join(
    runnerTemp,
    `checkout-git-trace-${crypto.randomUUID()}`
  )
  fs.mkdirSync(directory, {recursive: true})

  const setVariables: string[] = []
  const setIfUnset = (name: string, value: string): void => {
    if (process.env[name] === undefined) {
      process.env[name] = value
      setVariables.push(name)
    }
  }
  for (const [name, file] of Object.entries(TRACE_FILES)) {
    setIfUnset(name, path.join(directory, file))
  }
  setIfUnset('GIT_TRACE_CURL_NO_DATA', '1')

  return {directory, thresholdSeconds, startedAt: now(), setVariables}
}

function artifactName(id: string): string {
  const job = (process.env['GITHUB_JOB'] || 'job').replace(
    /[^A-Za-z0-9_.-]/g,
    '-'
  )
  const attempt = process.env['GITHUB_RUN_ATTEMPT'] || '1'
  return `checkout-git-trace-${job}-attempt-${attempt}-${id}`
}

export function redactor(secrets: string[]): (line: string) => string {
  const values = secrets
    .filter(secret => secret.length >= 4)
    .flatMap(secret => [
      secret,
      Buffer.from(`x-access-token:${secret}`, 'utf8').toString('base64')
    ])
  return line => {
    let result = line.replace(/(:\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1***@')
    for (const value of values) {
      result = result.split(value).join('***')
    }
    return result
  }
}

async function copyRedacted(
  source: string,
  destination: string,
  redact: (line: string) => string
): Promise<void> {
  const output = fs.createWriteStream(destination)
  const lines = readline.createInterface({
    input: fs.createReadStream(source),
    crlfDelay: Infinity
  })
  for await (const line of lines) {
    if (!output.write(`${redact(line)}\n`)) {
      await new Promise<void>(resolve => output.once('drain', () => resolve()))
    }
  }
  await new Promise<void>((resolve, reject) => {
    output.on('error', reject)
    output.end(resolve)
  })
}

export async function finish(
  trace: GitTrace | undefined,
  secrets: string[],
  now: () => number = Date.now
): Promise<void> {
  if (!trace) {
    return
  }
  for (const name of trace.setVariables) {
    delete process.env[name]
  }

  const elapsedSeconds = (now() - trace.startedAt) / 1000
  try {
    if (elapsedSeconds <= trace.thresholdSeconds) {
      return
    }

    const files = fs
      .readdirSync(trace.directory)
      .filter(file => fs.statSync(path.join(trace.directory, file)).isFile())
    if (files.length === 0) {
      core.warning(
        `Checkout took ${elapsedSeconds.toFixed(0)}s but no git trace files were written`
      )
      return
    }

    const id = crypto.randomUUID().slice(0, 8)
    const outputDirectory = path.join(
      path.dirname(trace.directory),
      OUTPUT_DIRECTORY,
      id
    )
    fs.mkdirSync(outputDirectory, {recursive: true})
    const redact = redactor(secrets)
    for (const file of files) {
      await copyRedacted(
        path.join(trace.directory, file),
        path.join(outputDirectory, file),
        redact
      )
    }

    core.exportVariable(DIRECTORY_VARIABLE, outputDirectory)
    core.exportVariable(ARTIFACT_VARIABLE, artifactName(id))
    core.warning(
      `Checkout took ${elapsedSeconds.toFixed(0)}s (threshold ${trace.thresholdSeconds}s); git traces written to ${outputDirectory}`
    )
  } catch (error) {
    core.warning(
      `Failed to save git traces: ${error instanceof Error ? error.message : error}`
    )
  } finally {
    try {
      fs.rmSync(trace.directory, {recursive: true, force: true})
    } catch (error) {
      core.warning(
        `Failed to remove ${trace.directory}: ${error instanceof Error ? error.message : error}`
      )
    }
  }
}
