/* eslint-disable i18n-text/no-en -- upstream conventions */
import {DefaultArtifactClient} from '@actions/artifact'
import * as core from '@actions/core'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

// Native git tracing for every checkout. The trace files are uploaded as an
// artifact only when the whole checkout exceeds the threshold, so slow
// fetches can be diagnosed after the fact without keeping traces for fast runs.

const DEFAULT_THRESHOLD_SECONDS = 180
const RETENTION_DAYS = 7

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

export interface ArtifactUploader {
  uploadArtifact(
    name: string,
    files: string[],
    rootDirectory: string,
    options: {retentionDays: number}
  ): Promise<{id?: number; size?: number}>
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

export function artifactName(): string {
  const job = (process.env['GITHUB_JOB'] || 'job').replace(
    /[^A-Za-z0-9_.-]/g,
    '-'
  )
  const attempt = process.env['GITHUB_RUN_ATTEMPT'] || '1'
  return `checkout-git-trace-${job}-attempt-${attempt}-${crypto
    .randomUUID()
    .slice(0, 8)}`
}

export async function finish(
  trace: GitTrace | undefined,
  uploader: ArtifactUploader = new DefaultArtifactClient(),
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
      .map(file => path.join(trace.directory, file))
      .filter(file => fs.statSync(file).isFile())
    if (files.length === 0) {
      core.warning(
        `Checkout took ${elapsedSeconds.toFixed(0)}s but no git trace files were written`
      )
      return
    }

    const name = artifactName()
    core.warning(
      `Checkout took ${elapsedSeconds.toFixed(0)}s (threshold ${trace.thresholdSeconds}s); uploading git trace artifact '${name}'`
    )
    const result = await uploader.uploadArtifact(name, files, trace.directory, {
      retentionDays: RETENTION_DAYS
    })
    core.info(
      `Uploaded git trace artifact '${name}' (id ${result.id}, ${result.size} bytes)`
    )
  } catch (error) {
    core.warning(
      `Failed to upload git trace artifact: ${error instanceof Error ? error.message : error}`
    )
  } finally {
    fs.rmSync(trace.directory, {recursive: true, force: true})
  }
}
