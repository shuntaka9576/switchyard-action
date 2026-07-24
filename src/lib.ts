export const CONTAINER_NAME = 'switchyard-action'

export function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}/v1`
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
