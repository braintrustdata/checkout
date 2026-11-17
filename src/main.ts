import * as core from '@actions/core'
import * as attempts from './warpbuild/attempts.js'
import * as gitSourceProvider from './git-source-provider.js'
import * as gitTrace from './warpbuild/git-trace.js'
import * as inputHelper from './input-helper.js'
import * as path from 'path'
import * as stateHelper from './state-helper.js'
import {fileURLToPath} from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function run(): Promise<void> {
  try {
    await attempts.run(attempts.getSettings(), {
      command: [process.execPath, ...process.argv.slice(1)],
      thresholdSeconds: gitTrace.getThresholdSeconds(),
      secrets: [core.getInput('token')]
    })
  } catch (error) {
    core.setFailed(`${(error as any)?.message ?? error}`)
  }
}

async function runAttempt(attempt: attempts.ChildAttempt): Promise<void> {
  try {
    const sourceSettings = await inputHelper.getInputs()

    try {
      // Register problem matcher
      core.info(
        `::add-matcher::${path.join(__dirname, 'problem-matcher.json')}`
      )

      // Get sources
      await gitSourceProvider.getSource(sourceSettings)
      core.setOutput('ref', sourceSettings.ref)
    } finally {
      // Unregister problem matcher
      core.info('::remove-matcher owner=checkout-git::')
    }
  } catch (error) {
    const message = `${(error as any)?.message ?? error}`
    if (attempt.attempt < attempt.maxAttempts) {
      core.warning(message)
      process.exitCode = 1
    } else {
      core.setFailed(message)
    }
  }
}

async function cleanup(): Promise<void> {
  try {
    await gitSourceProvider.cleanup(stateHelper.RepositoryPath)
  } catch (error) {
    core.warning(`${(error as any)?.message ?? error}`)
  }
}

// Main
const childAttempt = attempts.childAttempt()
if (stateHelper.IsPost) {
  cleanup()
} else if (childAttempt) {
  runAttempt(childAttempt)
}
// Parent
else {
  run()
}
