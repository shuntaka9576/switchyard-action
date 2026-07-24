import * as fs from 'node:fs'
import * as core from '@actions/core'
import { exec, getExecOutput } from '@actions/exec'
import { CONTAINER_NAME, analyzeRouteBundle, baseUrl, waitForHealth } from './lib'

async function run(): Promise<void> {
  const routeConfig = core.getInput('route-config', { required: true })
  const routeFile = fs.realpathSync(routeConfig)
  const bundle = analyzeRouteBundle(fs.readFileSync(routeFile, 'utf8'))

  // The bundle references its credentials as ${VAR}; forward exactly those
  // variables from the step environment into the container. Fail fast when
  // one is missing instead of letting upstream calls 401 later.
  for (const name of bundle.apiKeyEnvNames) {
    if (!process.env[name]) {
      throw new Error(
        `route bundle references \${${name}} but it is not set — add it via env: on this step`,
      )
    }
  }
  if (bundle.apiKeyEnvNames.length > 0) {
    core.info(`forwarding env into the router container: ${bundle.apiKeyEnvNames.join(', ')}`)
  }

  const image = core.getInput('image')

  const args = [
    'run',
    '-d',
    '--name',
    CONTAINER_NAME,
    '-p',
    '127.0.0.1:4100:4100',
    // Value-less -e form: docker reads the values from the inherited
    // environment, so secrets never appear in the command line or logs.
    ...bundle.apiKeyEnvNames.flatMap((name) => ['-e', name]),
    '-v',
    `${routeFile}:/app/route.yaml:ro`,
  ]
  const extraArgs = core.getInput('extra-docker-args').split(/\s+/).filter(Boolean)
  args.push(...extraArgs, image)

  await exec('docker', args)

  try {
    await waitForHealth(4100, 60_000)
  } catch (e) {
    const logs = await getExecOutput('docker', ['logs', CONTAINER_NAME], { ignoreReturnCode: true })
    core.info(`--- docker logs ${CONTAINER_NAME} ---\n${logs.stdout}\n${logs.stderr}`)
    throw e
  }
  core.info(`Switchyard router is healthy on ${baseUrl(4100)}`)

  core.setOutput('base-url', baseUrl(4100))

  // State for the post step. Everything flows through state so post never
  // reads inputs (inputs are unavailable to post on some failure paths).
  core.saveState('started', 'true')
  core.saveState('strong-models', JSON.stringify(bundle.strongModels))
  core.saveState('weak-models', JSON.stringify(bundle.weakModels))
  core.saveState('price-strong', core.getInput('price-strong-per-mtok'))
  core.saveState('price-weak', core.getInput('price-weak-per-mtok'))
}

run().catch((e) => core.setFailed(e instanceof Error ? e.message : String(e)))
