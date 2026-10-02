// A virtual clock for T0 pages (lane O6). Replaces infinite.fast's synchronous timer flush
// (`.github/scripts/test-inject-analytics.mjs` L1059, L1071), under which every `setTimeout` ran at once
// after the scripts, so no ordering or race could be expressed. Here time only moves when the runner
// advances it, timers fire in due-time order (ties in creation order), and the microtask queue is drained
// after every callback, so "the pixel request completes after 50 ms, the navigation waits for it" and
// "the 400 ms budget releases the navigation" are both observable. The fake PerformanceObserver is the
// growth-form harness's (`test-growth-lead-form.mjs` L102-138): resource entries are delivered only when
// the runner reports a request completed, never on their own.

export interface VirtualTimer {
  id: number
  due: number
  seq: number
  interval: number | null
  callback: () => void
}

export interface PerformanceEntryLike {
  name: string
  entryType: "resource"
  initiatorType: string
  startTime: number
  duration: number
}

type ObserverCallback = (list: { getEntries(): PerformanceEntryLike[] }, observer: unknown) => void

/** Drain pending promise jobs (vm contexts share the host's microtask queue). */
export async function drainMicrotasks(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

export class VirtualClock {
  /** Virtual epoch ms (wall-clock base) and elapsed virtual ms. */
  readonly epoch: number
  elapsed = 0
  private timers = new Map<number, VirtualTimer>()
  private nextId = 1
  private seq = 0
  private observers: Array<{ callback: ObserverCallback; types: string[]; connected: boolean; self: unknown }> = []
  /** Errors thrown by page callbacks (recorded, never rethrown into the runner). */
  readonly callbackErrors: string[] = []

  constructor(epoch = Date.UTC(2026, 9, 2, 9, 0, 0)) {
    this.epoch = epoch
  }

  now(): number {
    return this.epoch + this.elapsed
  }

  setTimeout(callback: unknown, delay: unknown, interval = false): number {
    const id = this.nextId++
    if (typeof callback !== "function") return id
    const ms = Math.max(0, Number(delay) || 0)
    this.timers.set(id, { id, due: this.elapsed + ms, seq: this.seq++, interval: interval ? Math.max(1, ms) : null, callback: callback as () => void })
    return id
  }

  clearTimeout(id: unknown): void {
    this.timers.delete(Number(id))
  }

  /** Delays of the pending timers, relative to now, in due order (the growth-form `pendingTimers()`). */
  pending(): number[] {
    return [...this.timers.values()].sort((a, b) => a.due - b.due || a.seq - b.seq).map((timer) => timer.due - this.elapsed)
  }

  /** Advance virtual time by `ms`, firing every timer that falls due, in order, draining microtasks after each. */
  async advance(ms: number): Promise<void> {
    const target = this.elapsed + Math.max(0, ms)
    await drainMicrotasks()
    for (let guard = 0; guard < 10_000; guard += 1) {
      const next = [...this.timers.values()].filter((timer) => timer.due <= target).sort((a, b) => a.due - b.due || a.seq - b.seq)[0]
      if (!next) break
      this.elapsed = Math.max(this.elapsed, next.due)
      if (next.interval !== null) {
        next.due += next.interval
        next.seq = this.seq++
      } else this.timers.delete(next.id)
      try {
        next.callback()
      } catch (error) {
        this.callbackErrors.push(error instanceof Error ? error.message : String(error))
      }
      await drainMicrotasks()
    }
    this.elapsed = target
    await drainMicrotasks()
  }

  /** The `Date` the page sees: `new Date()` and `Date.now()` read virtual time. */
  dateClass(): DateConstructor {
    const clock = this
    class VirtualDate extends Date {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(clock.now())
        else super(...(args as [string]))
      }
      static override now(): number {
        return clock.now()
      }
    }
    return VirtualDate as unknown as DateConstructor
  }

  performance(): { now(): number; timeOrigin: number; getEntriesByType(type: string): PerformanceEntryLike[] } {
    const entries = this.entries
    return {
      now: () => this.elapsed,
      timeOrigin: this.epoch,
      getEntriesByType: (type: string) => (type === "resource" ? [...entries] : [])
    }
  }

  private readonly entries: PerformanceEntryLike[] = []

  /** The fake `PerformanceObserver` class (observe/disconnect; entries only from `reportResource`). */
  performanceObserverClass(): unknown {
    const clock = this
    return class FakePerformanceObserver {
      private record: { callback: ObserverCallback; types: string[]; connected: boolean; self: unknown }
      constructor(callback: ObserverCallback) {
        this.record = { callback, types: [], connected: false, self: this }
      }
      observe(options?: { type?: string; entryTypes?: string[] }): void {
        const types = options?.entryTypes ?? (options?.type ? [options.type] : [])
        this.record.types.push(...types)
        if (!this.record.connected) {
          this.record.connected = true
          clock.observers.push(this.record)
        }
      }
      disconnect(): void {
        this.record.connected = false
      }
      takeRecords(): PerformanceEntryLike[] {
        return []
      }
      static get supportedEntryTypes(): string[] {
        return ["resource"]
      }
    }
  }

  /** How many observers are still connected (the growth-form `observing()`). */
  observing(): number {
    return this.observers.filter((observer) => observer.connected).length
  }

  /** A request completed: deliver one resource entry to every connected observer of `resource`. */
  reportResource(name: string, initiatorType: string, startTime: number): void {
    const entry: PerformanceEntryLike = { name, entryType: "resource", initiatorType, startTime, duration: Math.max(0, this.elapsed - startTime) }
    this.entries.push(entry)
    for (const observer of this.observers) {
      if (!observer.connected || !observer.types.includes("resource")) continue
      try {
        observer.callback({ getEntries: () => [entry] }, observer.self)
      } catch (error) {
        this.callbackErrors.push(error instanceof Error ? error.message : String(error))
      }
    }
  }
}
