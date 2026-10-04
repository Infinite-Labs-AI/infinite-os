// Run one T0 session — a throwaway browser profile and its actions — and return the recording (lane O6).
// Called ONLY from the sandboxed child (`child.ts`); see `vm-page.ts` for why.
import { VirtualClock } from "./clock.js"
import { CookieJar } from "./cookie-jar.js"
import type { T0ActionRecording, T0Session, T0SessionRecording } from "./protocol.js"
import { jsonSafe, T0Recorder } from "./recorders.js"
import { T0Page, type T0SessionState } from "./vm-page.js"

const DEFAULT_SETTLE_MS = 1500

export async function runSession(session: T0Session): Promise<T0SessionRecording> {
  const clock = new VirtualClock()
  const recorder = new T0Recorder(clock)
  const jar = new CookieJar()
  const state: T0SessionState = {
    jar,
    local: new Map(),
    session: new Map(),
    clock,
    recorder,
    posthogInits: [],
    metaPixels: [],
    ga4Configs: [],
    storageWrites: []
  }
  const actions: T0ActionRecording[] = []
  const globals: T0SessionRecording["globals"] = []
  let page: T0Page | null = null
  let error: string | null = null
  try {
    if (session.cookies?.length) {
      const first = session.actions.find((action) => action.kind === "load")
      jar.hostname = first && first.kind === "load" ? new URL(first.url).hostname : ""
      jar.seed(session.cookies)
    }
    for (const [index, action] of session.actions.entries()) {
      recorder.action = index
      const startedAt = clock.elapsed
      const record: T0ActionRecording = { kind: action.kind, label: action.label, startedAt, endedAt: startedAt, url: page?.href ?? null, scriptErrors: [] }
      const errorsBefore = page?.scriptErrors.length ?? 0
      switch (action.kind) {
        case "load": {
          page = new T0Page(state, action)
          record.url = page.href
          await page.load()
          globals.push({ action: index, defined: page.definedGlobals() })
          record.scriptErrors = [...page.scriptErrors]
          break
        }
        case "click": {
          if (!page) throw new Error("click before any load")
          record.found = await page.click(action.selector, action.settleMs ?? DEFAULT_SETTLE_MS)
          break
        }
        case "advance": {
          await clock.advance(action.ms)
          break
        }
        case "clear_storage": {
          if (action.local) state.local.clear()
          if (action.session) state.session.clear()
          break
        }
        case "set_storage": {
          ;(action.area === "local" ? state.local : state.session).set(action.key, action.value)
          break
        }
        case "eval": {
          if (!page) throw new Error("eval before any load")
          record.result = jsonSafe(await page.evaluate(action.expression, action.settleMs ?? DEFAULT_SETTLE_MS))
          break
        }
        case "spa_navigate": {
          if (!page) throw new Error("spa_navigate before any load")
          await page.spaNavigate(action.path, action.settleMs ?? DEFAULT_SETTLE_MS)
          break
        }
      }
      if (page) {
        for (const id of page.metaPixels) if (!state.metaPixels.includes(id)) state.metaPixels.push(id)
        for (const id of page.ga4Configs) if (!state.ga4Configs.includes(id)) state.ga4Configs.push(id)
      }
      if (action.kind !== "load" && page) record.scriptErrors = page.scriptErrors.slice(errorsBefore)
      record.scriptErrors.push(...clock.callbackErrors.splice(0))
      record.endedAt = clock.elapsed
      record.url = page?.href ?? null
      actions.push(record)
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  return {
    id: session.id,
    error,
    actions,
    requests: recorder.requests,
    timeline: recorder.timeline,
    cookieWrites: jar.writes,
    cookies: jar.entries(),
    posthogInits: state.posthogInits,
    metaPixels: state.metaPixels,
    ga4Configs: state.ga4Configs,
    globals,
    storageWrites: state.storageWrites,
    storage: [
      ...[...state.local].slice(0, 64).map(([key, value]) => ({ area: "local" as const, key, value: value.slice(0, 2048) })),
      ...[...state.session].slice(0, 64).map(([key, value]) => ({ area: "session" as const, key, value: value.slice(0, 2048) }))
    ]
  }
}
