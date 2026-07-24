import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as core from '@actions/core'
import { exec, getExecOutput } from '@actions/exec'
import { CONTAINER_NAME, baseUrl, generateRouteBundle, waitForHealth } from './lib'

async function run(): Promise<void> {
  const apiKey = core.getInput('api-key', { required: true })
  core.setSecret(apiKey)

  const image = core.getInput('image')
  const port = Number(core.getInput('port') || '4100')
  const routeConfig = core.getInput('route-config')
  const strongModel = core.getInput('strong-model')
  const weakModel = core.getInput('weak-model')

  // route-config replaces the generated bundle entirely (escape hatch for
  // three-tier setups, mixed providers, Anthropic-format upstreams, ...).
  let routeFile: string
  if (routeConfig) {
    routeFile = fs.realpathSync(routeConfig)
  } else {
    routeFile = path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'switchyard-route.yaml')
    fs.writeFileSync(
      routeFile,
      generateRouteBundle({
        upstreamBaseUrl: core.getInput('base-url'),
        strongModel,
        weakModel,
        classifierModel: core.getInput('classifier-model') || weakModel,
      }),
    )
  }

  const args = [
    'run',
    '-d',
    '--name',
    CONTAINER_NAME,
    '-p',
    `127.0.0.1:${port}:4100`,
    // Value-less form: docker reads the keys from the exec environment, so
    // they never appear in the command line or the step log.
    // FIREWORKS_API_KEY is kept as an alias for route-config files written
    // against the upstream bundle's variable name.
    '-e',
    'UPSTREAM_API_KEY',
    '-e',
    'FIREWORKS_API_KEY',
    '-v',
    `${routeFile}:/app/route.yaml:ro`,
  ]
  const extraArgs = core.getInput('extra-docker-args').split(/\s+/).filter(Boolean)
  args.push(...extraArgs, image)

  await exec('docker', args, {
    env: {
      ...(process.env as Record<string, string>),
      UPSTREAM_API_KEY: apiKey,
      FIREWORKS_API_KEY: apiKey,
    },
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

  // State for the post step. Everything flows through state so post never
  // reads inputs (inputs are unavailable to post on some failure paths).
  core.saveState('started', 'true')
  core.saveState('port', String(port))
  core.saveState('task-label', core.getInput('task-label'))
  core.saveState('strong-model', strongModel)
  core.saveState('weak-model', weakModel)
  core.saveState('price-strong', core.getInput('price-strong-per-mtok'))
  core.saveState('price-weak', core.getInput('price-weak-per-mtok'))
}

run().catch((e) => core.setFailed(e instanceof Error ? e.message : String(e)))
