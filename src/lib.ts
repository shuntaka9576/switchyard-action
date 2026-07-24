import { parse } from 'yaml'

export const CONTAINER_NAME = 'switchyard-action'

export function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}/v1`
}

export interface RouteBundleInfo {
  strongModels: string[]
  weakModels: string[]
  apiKeyEnvNames: string[]
}

// Static analysis of the user's route bundle. Two purposes: learn which
// model ids belong to which tier (post-step aggregation needs no extra
// inputs), and learn which ${ENV_VAR} names the bundle's api_key entries
// reference (exactly those variables get forwarded from the step
// environment into the container). Unparseable bundles yield empty
// results and downstream falls back to heuristics.
export function analyzeRouteBundle(routeYaml: string): RouteBundleInfo {
  const strong = new Set<string>()
  const weak = new Set<string>()
  const envNames = new Set<string>()
  try {
    const doc = parse(routeYaml) as {
      routes?: Record<
        string,
        {
          strong?: { model?: string }
          weak?: { model?: string }
          classifier?: { model?: string }
        }
      >
    }
    for (const route of Object.values(doc?.routes ?? {})) {
      if (route?.strong?.model) strong.add(route.strong.model)
      if (route?.weak?.model) weak.add(route.weak.model)
      if (route?.classifier?.model) weak.add(route.classifier.model)
    }
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk)
        return
      }
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          if (key === 'api_key' && typeof value === 'string') {
            for (const m of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) envNames.add(m[1])
          } else {
            walk(value)
          }
        }
      }
    }
    walk(doc)
  } catch {
    // fall through with what we have
  }
  return { strongModels: [...strong], weakModels: [...weak], apiKeyEnvNames: [...envNames] }
}

export async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) return
      lastError = `HTTP ${res.status}`
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`router did not become healthy within ${timeoutMs / 1000}s (last error: ${lastError})`)
}
