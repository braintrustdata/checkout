import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  ArtifactUploader,
  finish,
  getThresholdSeconds,
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
  'INPUT_GIT-TRACE-THRESHOLD-SECONDS'
]
const savedEnv = new Map(managedVariables.map(key => [key, process.env[key]]))

function uploaderMock() {
  const uploadArtifact = jest.fn<ArtifactUploader['uploadArtifact']>()
  uploadArtifact.mockResolvedValue({id: 1, size: 2})
  return {uploader: {uploadArtifact}, uploadArtifact}
}

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

  it('uploads traces when the checkout is slow', async () => {
    let clock = 1_000
    const trace = start(180, () => clock)
    expect(trace).toBeDefined()
    expect(process.env['GIT_TRACE_CURL_NO_DATA']).toBe('1')
    expect(path.dirname(process.env['GIT_TRACE2_EVENT'] as string)).toBe(
      trace?.directory
    )
    fs.writeFileSync(process.env['GIT_TRACE'] as string, 'trace')
    fs.writeFileSync(process.env['GIT_TRACE2_EVENT'] as string, '{}')

    clock += 181_000
    const {uploader, uploadArtifact} = uploaderMock()
    await finish(trace, uploader, () => clock)

    expect(uploadArtifact).toHaveBeenCalledTimes(1)
    const [name, files, root, options] = uploadArtifact.mock.calls[0]
    expect(name).toMatch(
      /^checkout-git-trace-frontend-verify-attempt-2-[0-9a-f]{8}$/
    )
    expect(files.map(file => path.basename(file)).sort()).toEqual([
      'trace.log',
      'trace2-event.json'
    ])
    expect(root).toBe(trace?.directory)
    expect(options).toEqual({retentionDays: 7})
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
    const {uploader, uploadArtifact} = uploaderMock()
    await finish(trace, uploader, () => clock)

    expect(uploadArtifact).not.toHaveBeenCalled()
    expect(fs.existsSync(trace?.directory as string)).toBe(false)
  })

  it('keeps trace variables set by the workflow', async () => {
    process.env['GIT_TRACE'] = '1'
    const trace = start(180)
    expect(process.env['GIT_TRACE']).toBe('1')
    await finish(trace, uploaderMock().uploader)
    expect(process.env['GIT_TRACE']).toBe('1')
  })

  it('does not fail the checkout when the upload fails', async () => {
    let clock = 1_000
    const trace = start(1, () => clock)
    fs.writeFileSync(process.env['GIT_TRACE'] as string, 'trace')
    clock += 2_000
    const {uploader, uploadArtifact} = uploaderMock()
    uploadArtifact.mockRejectedValue(new Error('no runtime token'))
    await expect(finish(trace, uploader, () => clock)).resolves.toBeUndefined()
  })
})
