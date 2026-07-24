import * as fs from 'node:fs'
import * as core from '@actions/core'
import { exec, getExecOutput } from '@actions/exec'
import { CONTAINER_NAME, baseUrl, waitForHealth } from './lib'

async function run(): Promise<void> {
  const apiKey = core.getInput('fireworks-api-key', { required: true })
  core.setSecret(apiKey)

  const image = core.getInput('image')
  const port = Number(core.getInput('port') || '4100')
  const routeConfig = core.getInput('route-config')

  const args = [
    'run',
    '-d',
    '--name',
    CONTAINER_NAME,
    '-p',
    `127.0.0.1:${port}:4100`,
    // Value-less form: docker reads the key from the exec environment, so
    // it never appears in the command line or the step log.
    '-e',
    'FIREWORKS_API_KEY',
  ]
  if (routeConfig) {
    const abs = fs.realpathSync(routeConfig)
    args.push('-v', `${abs}:/app/route.yaml:ro`)
  }
  const extraArgs = core.getInput('extra-docker-args').split(/\s+/).filter(Boolean)
  args.push(...extraArgs, image)

  await exec('docker', args, {
    env: { ...(process.env as Record<string, string>), FIREWORKS_API_KEY: apiKey },
  })

  try {
    await waitForHealth(port, 60_000)
  } catch (e) {
    const logs = await getExecOutput('docker', ['logs', CONTAINER_NAME], { ignoreReturnCode: true })
    core.info(`--- docker logs ${CONTAINER_NAME} ---\n${logs.stdout}\n${logs.stderr}`)
    throw e
  }
  core.info(`Switchyard router is healthy on ${baseUrl(port)}`)

  core.setOutput('base-url', baseUrl(port))

  // State for the post step. Prices flow through state so post never reads
  // inputs (inputs are unavailable to post on some failure paths).
  core.saveState('started', 'true')
  core.saveState('port', String(port))
  core.saveState('task-label', core.getInput('task-label'))
  core.saveState('price-strong', core.getInput('price-strong-per-mtok'))
  core.saveState('price-weak', core.getInput('price-weak-per-mtok'))
}

run().catch((e) => core.setFailed(e instanceof Error ? e.message : String(e)))
