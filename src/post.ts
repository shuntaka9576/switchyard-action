import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as core from '@actions/core'
import { exec, getExecOutput } from '@actions/exec'
import { DefaultArtifactClient } from '@actions/artifact'
import { CONTAINER_NAME } from './lib'

interface RoutingRecord {
  tier?: string
  model?: string
  total_tokens?: number
  [key: string]: unknown
}

function prNumber(): number | null {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath || !fs.existsSync(eventPath)) return null
  try {
    const payload = JSON.parse(fs.readFileSync(eventPath, 'utf8'))
    return payload.pull_request?.number ?? payload.issue?.number ?? null
  } catch {
    return null
  }
}

function routeKey(r: RoutingRecord): string {
  // Auto-routed lines carry tier=strong/weak; tier-pinned routes log an
  // empty tier, so label those by model (same rule as stats-snapshot.sh).
  if (r.tier) return r.tier
  const model = r.model ?? 'unknown'
  return `pinned:${model.split('/').pop()}`
}

function makeIsStrong(strongModels: string[], weakModels: string[]): (r: RoutingRecord) => boolean {
  const strong = new Set(strongModels)
  const weak = new Set(weakModels)
  return (r) => {
    if (r.tier === 'strong') return true
    if (r.tier === 'weak') return false
    const model = r.model ?? ''
    if (strong.has(model)) return true
    if (weak.has(model)) return false
    return model.includes('pro') // last-resort heuristic
  }
}

async function run(): Promise<void> {
  if (core.getState('started') !== 'true') {
    core.info('router was never started; nothing to collect')
    return
  }
  const port = 4100
  const priceStrong = Number(core.getState('price-strong'))
  const priceWeak = Number(core.getState('price-weak'))
  const hasPrices = priceStrong > 0 && priceWeak > 0
  const isStrong = makeIsStrong(
    JSON.parse(core.getState('strong-models') || '[]'),
    JSON.parse(core.getState('weak-models') || '[]'),
  )

  const outDir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'switchyard-stats-'))

  // 1. Aggregate stats endpoint. In CI the container is fresh per run, so
  // these counters are exactly this run's usage.
  const statsPath = path.join(outDir, 'stats.json')
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/routing/stats`, {
      signal: AbortSignal.timeout(5000),
    })
    fs.writeFileSync(statsPath, await res.text())
  } catch (e) {
    core.warning(`could not fetch /v1/routing/stats: ${e instanceof Error ? e.message : e}`)
    fs.writeFileSync(statsPath, '{}')
  }

  // 2. Per-request log out of the container.
  const rawLogPath = path.join(outDir, 'routing-raw.jsonl')
  const cp = await getExecOutput(
    'docker',
    ['cp', `${CONTAINER_NAME}:/app/logs/routing.jsonl`, rawLogPath],
    { ignoreReturnCode: true },
  )
  const rawLines =
    cp.exitCode === 0 && fs.existsSync(rawLogPath)
      ? fs.readFileSync(rawLogPath, 'utf8').split('\n').filter(Boolean)
      : []

  // 3. Normalize: attach run context to every record so local aggregation
  // can just concatenate artifacts.
  const ctx = {
    repo: process.env.GITHUB_REPOSITORY ?? '',
    workflow: process.env.GITHUB_WORKFLOW ?? '',
    run_id: Number(process.env.GITHUB_RUN_ID ?? '0'),
    run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? '1'),
    job: process.env.GITHUB_JOB ?? '',
    pr: prNumber(),
    actor: process.env.GITHUB_ACTOR ?? '',
    collected_at: new Date().toISOString(),
  }
  const records: RoutingRecord[] = []
  for (const line of rawLines) {
    try {
      records.push({ ...ctx, ...JSON.parse(line) })
    } catch {
      core.warning(`skipping malformed routing.jsonl line: ${line.slice(0, 200)}`)
    }
  }
  const normalizedPath = path.join(outDir, 'routing.jsonl')
  fs.writeFileSync(normalizedPath, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''))
  fs.rmSync(rawLogPath, { force: true })

  // 4. Aggregate for summary/outputs.
  const perRoute = new Map<string, { requests: number; tokens: number }>()
  let strongReqs = 0
  let weakReqs = 0
  let strongTokens = 0
  let weakTokens = 0
  for (const r of records) {
    const key = routeKey(r)
    const agg = perRoute.get(key) ?? { requests: 0, tokens: 0 }
    agg.requests += 1
    agg.tokens += r.total_tokens ?? 0
    perRoute.set(key, agg)
    if (isStrong(r)) {
      strongReqs += 1
      strongTokens += r.total_tokens ?? 0
    } else {
      weakReqs += 1
      weakTokens += r.total_tokens ?? 0
    }
  }
  const totalTokens = strongTokens + weakTokens
  const cost = (strongTokens * priceStrong + weakTokens * priceWeak) / 1e6
  const proOnlyCost = (totalTokens * priceStrong) / 1e6
  const savings = proOnlyCost - cost

  core.setOutput('strong-requests', String(strongReqs))
  core.setOutput('weak-requests', String(weakReqs))
  core.setOutput('total-tokens', String(totalTokens))
  if (hasPrices) {
    core.setOutput('estimated-cost-usd', cost.toFixed(4))
    core.setOutput('estimated-savings-usd', savings.toFixed(4))
  }

  // 5. Step Summary.
  const summary = core.summary.addHeading('Switchyard routing stats', 3)
  if (records.length === 0) {
    summary.addRaw('No requests were routed in this run.')
  } else {
    const rows = [...perRoute.entries()].sort((a, b) => b[1].requests - a[1].requests)
    summary.addTable([
      [
        { data: 'route', header: true },
        { data: 'requests', header: true },
        { data: 'req%', header: true },
        { data: 'total_tokens', header: true },
      ],
      ...rows.map(([key, agg]) => [
        key,
        String(agg.requests),
        `${((100 * agg.requests) / records.length).toFixed(1)}%`,
        agg.tokens.toLocaleString('en-US'),
      ]),
    ])
    if (hasPrices) {
      summary.addRaw(
        `Estimated cost: $${cost.toFixed(4)} — estimated savings vs strong-only: $${savings.toFixed(4)} ` +
          `(prices: strong $${priceStrong}/Mtok, weak $${priceWeak}/Mtok; total_tokens-based approximation)`,
      )
    }
  }
  await summary.write()

  // 6. Artifact. The job name is part of the artifact name because v4
  // artifact names are immutable within a run (two jobs, one run).
  const artifactName = `switchyard-stats-${ctx.run_id}-${ctx.job}`.replace(/[^a-zA-Z0-9-_]/g, '_')
  try {
    const client = new DefaultArtifactClient()
    await client.uploadArtifact(artifactName, [normalizedPath, statsPath], outDir)
    core.info(`uploaded artifact ${artifactName} (${records.length} records)`)
  } catch (e) {
    core.warning(`artifact upload failed: ${e instanceof Error ? e.message : e}`)
  }

  // 7. Tear down.
  await exec('docker', ['rm', '-f', CONTAINER_NAME], { ignoreReturnCode: true })
}

run().catch((e) => core.setFailed(e instanceof Error ? e.message : String(e)))
