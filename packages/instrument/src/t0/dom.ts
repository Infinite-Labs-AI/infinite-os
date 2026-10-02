// A minimal DOM for T0 pages (lane O6). Ported and widened from infinite-site
// `.github/scripts/test-inject-analytics.mjs` L1149-1276 @ 9f65b47: nodes that track children,
// attributes and listeners, capture-phase listeners in their own bucket fired BEFORE the bubble phase
// (the handoff handler depends on that order), and REFLECTED anchor `target` / `rel` (a plain property
// would let a broken snippet pass while the real page still self-navigated). Added for customer sites:
// a small HTML parser for the page's own markup (so a click test can find `[data-infinite-conversion]`
// in static HTML), a selector engine (compound selectors, descendant and child combinators, lists),
// full event propagation (window → document → … → target → … → window), default actions for anchor
// clicks and form submits, and hooks so the page runner sees every inserted script and image.
//
// It is not a browser. It models what analytics snippets and conversion handlers touch; anything else
// is a harmless no-op. React components are never rendered here (those are rehearsal clicks).

export interface DomHooks {
  /** A `<script>` element was connected to the document. */
  onScriptConnected(node: T0Element): void
  /** An `<img>`'s `src` was set (connected or not: browsers fetch on assignment). */
  onImageSrc(node: T0Element, src: string): void
  /** The default action of an anchor click (not prevented). */
  onAnchorActivation(anchor: T0Element, event: T0Event): void
  /** The default action of a form submit (not prevented), or `form.submit()`. */
  onFormSubmission(form: T0Element, viaMethod: boolean): void
}

// The links the RECORDING depends on (an element's document, the document's hooks and URL resolver) live
// in module-private WeakMaps, never in page-visible properties: page code that reassigns
// `document.hooks`, `document.resolveUrl` or `el.ownerDocument` must not be able to make a `src` it
// really set go unrecorded (review O6-R6). The public `ownerDocument` / `resolveUrl` are read-only views.
const OWNER = new WeakMap<object, T0Document>()
const INTERNALS = new WeakMap<object, { hooks: DomHooks; resolveUrl: (raw: string) => string }>()

function docOf(node: object): T0Document {
  const doc = OWNER.get(node)
  if (!doc) throw new Error("T0: a node without its document")
  return doc
}

function internalsOf(doc: object): { hooks: DomHooks; resolveUrl: (raw: string) => string } {
  const internals = INTERNALS.get(doc)
  if (!internals) throw new Error("T0: a document without its hooks")
  return internals
}

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"])
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title", "noscript"])
const REFLECTED = ["id", "href", "src", "type", "rel", "target", "name", "action", "method", "value", "title", "alt", "role", "async", "defer", "crossOrigin"]

export class T0Event {
  type: string
  bubbles: boolean
  cancelable: boolean
  defaultPrevented = false
  target: unknown = null
  currentTarget: unknown = null
  eventPhase = 0
  button = 0
  ctrlKey = false
  metaKey = false
  shiftKey = false
  altKey = false
  detail: unknown
  isTrusted = false
  timeStamp = 0
  submitter: unknown = null
  stopped = false
  stoppedImmediate = false
  constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean; detail?: unknown; button?: number } = {}) {
    this.type = String(type)
    this.bubbles = init.bubbles === true
    this.cancelable = init.cancelable === true
    this.detail = init.detail
    if (typeof init.button === "number") this.button = init.button
  }
  preventDefault(): void {
    if (this.cancelable) this.defaultPrevented = true
  }
  stopPropagation(): void {
    this.stopped = true
  }
  stopImmediatePropagation(): void {
    this.stopped = true
    this.stoppedImmediate = true
  }
  composedPath(): unknown[] {
    return []
  }
}

export class T0CustomEvent extends T0Event {
  constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean; detail?: unknown } = {}) {
    super(type, init)
  }
}

type Listener = { fn: unknown; capture: boolean; once: boolean }

/** Shared listener storage for nodes, the document and the window. */
export class T0EventTarget {
  listeners = new Map<string, Listener[]>()
  addEventListener(type: string, fn: unknown, options?: boolean | { capture?: boolean; once?: boolean }): void {
    if (!fn) return
    const capture = options === true || (typeof options === "object" && options !== null && options.capture === true)
    const once = typeof options === "object" && options !== null && options.once === true
    const list = this.listeners.get(type) ?? []
    if (list.some((entry) => entry.fn === fn && entry.capture === capture)) return
    list.push({ fn, capture, once })
    this.listeners.set(type, list)
  }
  removeEventListener(type: string, fn: unknown, options?: boolean | { capture?: boolean }): void {
    const capture = options === true || (typeof options === "object" && options !== null && options.capture === true)
    const list = this.listeners.get(type)
    if (!list) return
    this.listeners.set(
      type,
      list.filter((entry) => !(entry.fn === fn && entry.capture === capture))
    )
  }
  /** Run this target's listeners for one phase. Errors are reported, never thrown into the dispatcher. */
  invoke(event: T0Event, phase: "capture" | "target" | "bubble", report: (error: unknown) => void): void {
    const list = [...(this.listeners.get(event.type) ?? [])]
    for (const entry of list) {
      if (phase === "capture" && !entry.capture) continue
      if (phase === "bubble" && entry.capture) continue
      if (entry.once) this.removeEventListener(event.type, entry.fn, entry.capture)
      event.currentTarget = this
      try {
        if (typeof entry.fn === "function") entry.fn.call(this, event)
        else if (entry.fn && typeof (entry.fn as { handleEvent?: unknown }).handleEvent === "function")
          (entry.fn as { handleEvent(event: T0Event): void }).handleEvent(event)
      } catch (error) {
        report(error)
      }
      if (event.stoppedImmediate) return
    }
  }
}

export class T0Text {
  nodeType = 3
  nodeName = "#text"
  parentNode: T0Element | null = null
  constructor(public data: string) {}
  get textContent(): string {
    return this.data
  }
}

export class T0Element extends T0EventTarget {
  nodeType = 1
  readonly localName: string
  readonly attributeMap = new Map<string, string>()
  childNodes: Array<T0Element | T0Text> = []
  parentNode: T0Element | null = null
  style: Record<string, string> = {}
  /** Inline script text, `script.text` / `textContent`. */
  private ownText = ""
  disabled = false
  checked = false
  constructor(ownerDocument: T0Document, tagName: string) {
    super()
    OWNER.set(this, ownerDocument)
    this.localName = tagName.toLowerCase()
    for (const name of REFLECTED) {
      const attr = name === "crossOrigin" ? "crossorigin" : name
      Object.defineProperty(this, name, {
        configurable: true,
        enumerable: true,
        get: () => {
          const raw = this.attributeMap.get(attr)
          if (name === "href" || name === "src" || name === "action") return raw === undefined ? "" : internalsOf(docOf(this)).resolveUrl(raw)
          if (name === "async" || name === "defer") return raw !== undefined
          return raw ?? ""
        },
        set: (value: unknown) => {
          if (name === "async" || name === "defer") {
            if (value) this.setAttribute(attr, "")
            else this.removeAttribute(attr)
            return
          }
          this.setAttribute(attr, String(value))
        }
      })
    }
  }
  get tagName(): string {
    return this.localName.toUpperCase()
  }
  get nodeName(): string {
    return this.tagName
  }
  get children(): T0Element[] {
    return this.childNodes.filter((node): node is T0Element => node instanceof T0Element)
  }
  get parentElement(): T0Element | null {
    return this.parentNode
  }
  get firstChild(): T0Element | T0Text | null {
    return this.childNodes[0] ?? null
  }
  get className(): string {
    return this.attributeMap.get("class") ?? ""
  }
  set className(value: string) {
    this.setAttribute("class", value)
  }
  get classList(): { contains(name: string): boolean; add(...names: string[]): void; remove(...names: string[]): void } {
    const names = () => this.className.split(/\s+/).filter(Boolean)
    return {
      contains: (name: string) => names().includes(name),
      add: (...added: string[]) => this.setAttribute("class", [...new Set([...names(), ...added])].join(" ")),
      remove: (...removed: string[]) => this.setAttribute("class", names().filter((name) => !removed.includes(name)).join(" "))
    }
  }
  get dataset(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [name, value] of this.attributeMap) {
      if (!name.startsWith("data-")) continue
      out[name.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = value
    }
    return out
  }
  get text(): string {
    return this.textContent
  }
  set text(value: string) {
    this.textContent = value
  }
  get textContent(): string {
    if (this.localName === "script" || this.localName === "style") return this.ownText
    return this.childNodes.map((node) => node.textContent).join("")
  }
  set textContent(value: string) {
    if (this.localName === "script" || this.localName === "style") {
      this.ownText = String(value)
      return
    }
    this.childNodes = []
    if (value) this.appendChild(new T0Text(String(value)))
  }
  get innerText(): string {
    return this.textContent
  }
  set innerText(value: string) {
    this.textContent = value
  }
  set innerHTML(markup: string) {
    this.childNodes = []
    parseMarkupInto(this, String(markup))
  }
  get innerHTML(): string {
    return ""
  }
  get ownerDocument(): T0Document {
    return docOf(this)
  }
  get isConnected(): boolean {
    let node: T0Element | null = this
    const root = docOf(this).documentElement
    while (node) {
      if (node === root) return true
      node = node.parentNode
    }
    return false
  }
  setAttribute(name: string, value: unknown): void {
    const key = String(name).toLowerCase()
    this.attributeMap.set(key, String(value))
    if (key === "src" && this.localName === "img") {
      const internals = internalsOf(docOf(this))
      internals.hooks.onImageSrc(this, internals.resolveUrl(String(value)))
    }
  }
  getAttribute(name: string): string | null {
    return this.attributeMap.get(String(name).toLowerCase()) ?? null
  }
  hasAttribute(name: string): boolean {
    return this.attributeMap.has(String(name).toLowerCase())
  }
  removeAttribute(name: string): void {
    this.attributeMap.delete(String(name).toLowerCase())
  }
  appendChild<T extends T0Element | T0Text>(child: T): T {
    return this.insertBefore(child, null)
  }
  insertBefore<T extends T0Element | T0Text>(child: T, reference: T0Element | T0Text | null): T {
    if (!child || typeof child !== "object") return child
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    const index = reference ? this.childNodes.indexOf(reference) : -1
    if (index === -1) this.childNodes.push(child)
    else this.childNodes.splice(index, 0, child)
    if (child instanceof T0Element && this.isConnected) docOf(this).connected(child)
    return child
  }
  append(...nodes: Array<T0Element | T0Text | string>): void {
    for (const node of nodes) this.appendChild(typeof node === "string" ? new T0Text(node) : node)
  }
  prepend(...nodes: Array<T0Element | T0Text | string>): void {
    for (const node of nodes.reverse()) this.insertBefore(typeof node === "string" ? new T0Text(node) : node, this.childNodes[0] ?? null)
  }
  removeChild<T extends T0Element | T0Text>(child: T): T {
    this.childNodes = this.childNodes.filter((node) => node !== child)
    if (child && child.parentNode === this) child.parentNode = null
    return child
  }
  remove(): void {
    this.parentNode?.removeChild(this)
  }
  contains(other: unknown): boolean {
    let node = other as T0Element | null
    while (node) {
      if (node === this) return true
      node = node.parentNode
    }
    return false
  }
  matches(selector: string): boolean {
    return matchesSelector(this, selector)
  }
  closest(selector: string): T0Element | null {
    let node: T0Element | null = this
    while (node) {
      if (matchesSelector(node, selector)) return node
      node = node.parentNode
    }
    return null
  }
  querySelectorAll(selector: string): T0Element[] {
    const out: T0Element[] = []
    const visit = (node: T0Element) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) out.push(child)
        visit(child)
      }
    }
    visit(this)
    return out
  }
  querySelector(selector: string): T0Element | null {
    return this.querySelectorAll(selector)[0] ?? null
  }
  getElementsByTagName(name: string): T0Element[] {
    const lower = String(name).toLowerCase()
    return this.querySelectorAll("*").filter((node) => lower === "*" || node.localName === lower)
  }
  getElementsByClassName(name: string): T0Element[] {
    return this.querySelectorAll(`.${name}`)
  }
  getBoundingClientRect(): { top: number; left: number; width: number; height: number; right: number; bottom: number } {
    return { top: 0, left: 0, width: 100, height: 20, right: 100, bottom: 20 }
  }
  focus(): void {}
  blur(): void {}
  dispatchEvent(event: T0Event): boolean {
    return docOf(this).dispatch(this, event)
  }
  /** `element.click()`: a trusted-shaped click that bubbles and runs the default action. */
  click(): void {
    const event = new T0Event("click", { bubbles: true, cancelable: true, button: 0 })
    docOf(this).dispatch(this, event)
  }
  /** `form.submit()`: no submit event, straight to the submission (the HTML spec). */
  submit(): void {
    if (this.localName === "form") internalsOf(docOf(this)).hooks.onFormSubmission(this, true)
  }
  requestSubmit(): void {
    if (this.localName !== "form") return
    const event = new T0Event("submit", { bubbles: true, cancelable: true })
    docOf(this).dispatch(this, event)
  }
}

export class T0Document extends T0EventTarget {
  nodeType = 9
  nodeName = "#document"
  readonly documentElement: T0Element
  readonly head: T0Element
  readonly body: T0Element
  readyState: "loading" | "interactive" | "complete" = "loading"
  visibilityState = "visible"
  hidden = false
  title = ""
  referrer = ""
  /** Set by the page: the window to bubble to, the URL resolver, error reporting. */
  windowTarget: T0EventTarget | null = null
  reportError: (error: unknown) => void = () => undefined
  constructor(hooks: DomHooks, resolveUrl: (raw: string) => string) {
    super()
    INTERNALS.set(this, { hooks, resolveUrl })
    this.documentElement = new T0Element(this, "html")
    this.head = new T0Element(this, "head")
    this.body = new T0Element(this, "body")
    this.head.parentNode = this.documentElement
    this.body.parentNode = this.documentElement
    this.documentElement.childNodes.push(this.head, this.body)
  }
  /** Resolve a URL against the page (read-only: the recording relies on it). */
  resolveUrl(raw: string): string {
    return internalsOf(this).resolveUrl(raw)
  }
  get scripts(): T0Element[] {
    return this.getElementsByTagName("script")
  }
  createElement(tagName: string): T0Element {
    return new T0Element(this, String(tagName))
  }
  createElementNS(_ns: string, tagName: string): T0Element {
    return new T0Element(this, String(tagName))
  }
  createTextNode(text: string): T0Text {
    return new T0Text(String(text))
  }
  createDocumentFragment(): T0Element {
    return new T0Element(this, "#fragment")
  }
  createEvent(): T0Event {
    const event = new T0Event("")
    ;(event as T0Event & { initEvent(type: string, bubbles: boolean, cancelable: boolean): void }).initEvent = (type, bubbles, cancelable) => {
      event.type = type
      event.bubbles = bubbles
      event.cancelable = cancelable
    }
    return event
  }
  getElementById(id: string): T0Element | null {
    return this.documentElement.querySelectorAll("*").find((node) => node.getAttribute("id") === id) ?? null
  }
  querySelector(selector: string): T0Element | null {
    if (matchesSelector(this.documentElement, selector)) return this.documentElement
    return this.documentElement.querySelector(selector)
  }
  querySelectorAll(selector: string): T0Element[] {
    return [...(matchesSelector(this.documentElement, selector) ? [this.documentElement] : []), ...this.documentElement.querySelectorAll(selector)]
  }
  getElementsByTagName(name: string): T0Element[] {
    const lower = String(name).toLowerCase()
    return [...(lower === "html" || lower === "*" ? [this.documentElement] : []), ...this.documentElement.getElementsByTagName(name)]
  }
  getElementsByClassName(name: string): T0Element[] {
    return this.documentElement.getElementsByClassName(name)
  }
  hasFocus(): boolean {
    return true
  }
  /** A subtree was connected: report every script inside it (in tree order). */
  connected(node: T0Element): void {
    if (node.localName === "script") internalsOf(this).hooks.onScriptConnected(node)
    for (const child of node.children) this.connected(child)
  }
  dispatchEvent(event: T0Event): boolean {
    event.target = this
    const window = this.windowTarget
    event.eventPhase = 1
    if (window && !event.stopped) window.invoke(event, "capture", this.reportError)
    event.eventPhase = 2
    if (!event.stopped) this.invoke(event, "target", this.reportError)
    event.eventPhase = 3
    if (event.bubbles && window && !event.stopped) window.invoke(event, "bubble", this.reportError)
    return !event.defaultPrevented
  }
  /** Dispatch on a node: capture (window → document → ancestors), target, bubble, then the default action. */
  dispatch(target: T0Element, event: T0Event): boolean {
    event.target = target
    const ancestors: T0Element[] = []
    let node = target.parentNode
    while (node) {
      ancestors.unshift(node)
      node = node.parentNode
    }
    const connected = target.isConnected
    const window = this.windowTarget
    const capturePath: T0EventTarget[] = [...(connected && window ? [window] : []), ...(connected ? [this] : []), ...ancestors]
    event.eventPhase = 1
    for (const current of capturePath) {
      if (event.stopped) break
      current.invoke(event, "capture", this.reportError)
    }
    event.eventPhase = 2
    if (!event.stopped) target.invoke(event, "target", this.reportError)
    if (event.bubbles) {
      event.eventPhase = 3
      for (const current of [...capturePath].reverse()) {
        if (event.stopped) break
        current.invoke(event, "bubble", this.reportError)
      }
    }
    event.eventPhase = 0
    event.currentTarget = null
    if (!event.defaultPrevented) this.defaultAction(target, event)
    return !event.defaultPrevented
  }
  private defaultAction(target: T0Element, event: T0Event): void {
    if (event.type === "click") {
      const anchor = target.closest("a[href]")
      if (anchor) {
        internalsOf(this).hooks.onAnchorActivation(anchor, event)
        return
      }
      const submitter = target.closest("button, input[type=submit]")
      const form = submitter ? submitter.closest("form") : null
      const type = submitter ? (submitter.getAttribute("type") ?? "submit").toLowerCase() : ""
      if (submitter && form && type === "submit") {
        const submit = new T0Event("submit", { bubbles: true, cancelable: true })
        submit.submitter = submitter
        this.dispatch(form, submit)
      }
      return
    }
    if (event.type === "submit" && target.localName === "form") internalsOf(this).hooks.onFormSubmission(target, false)
  }
}

// ---- markup ------------------------------------------------------------------------------------

/** Parse HTML markup into `parent` (elements, attributes and text; comments dropped; scripts kept with their text). */
export function parseMarkupInto(parent: T0Element, markup: string): void {
  const document = docOf(parent)
  const stack: T0Element[] = [parent]
  const top = () => stack[stack.length - 1]!
  let at = 0
  while (at < markup.length) {
    const lt = markup.indexOf("<", at)
    if (lt === -1) {
      const text = markup.slice(at)
      if (text.trim()) top().appendChild(new T0Text(text))
      break
    }
    if (lt > at) {
      const text = markup.slice(at, lt)
      if (text.trim()) top().appendChild(new T0Text(text))
    }
    if (markup.startsWith("<!--", lt)) {
      const end = markup.indexOf("-->", lt + 4)
      at = end === -1 ? markup.length : end + 3
      continue
    }
    if (markup.startsWith("<!", lt) || markup.startsWith("<?", lt)) {
      const end = markup.indexOf(">", lt)
      at = end === -1 ? markup.length : end + 1
      continue
    }
    const closing = markup[lt + 1] === "/"
    const nameMatch = /^[A-Za-z][A-Za-z0-9:-]*/.exec(markup.slice(lt + (closing ? 2 : 1)))
    if (!nameMatch) {
      top().appendChild(new T0Text("<"))
      at = lt + 1
      continue
    }
    const name = nameMatch[0].toLowerCase()
    const tagEnd = findTagEnd(markup, lt)
    if (tagEnd === -1) break
    if (closing) {
      const index = stack.map((node) => node.localName).lastIndexOf(name)
      if (index > 0) stack.length = index
      at = tagEnd + 1
      continue
    }
    const rawAttributes = markup.slice(lt + 1 + nameMatch[0].length, markup[tagEnd - 1] === "/" ? tagEnd - 1 : tagEnd)
    // Structural tags of a full document map onto the document's own nodes.
    if (name === "html" || name === "head" || name === "body") {
      const target = name === "html" ? document.documentElement : name === "head" ? document.head : document.body
      for (const [key, value] of parseAttributes(rawAttributes)) target.attributeMap.set(key, value)
      if (name !== "html") stack.splice(1, stack.length - 1, target)
      at = tagEnd + 1
      continue
    }
    const element = new T0Element(document, name)
    for (const [key, value] of parseAttributes(rawAttributes)) element.attributeMap.set(key, value)
    if (RAW_TEXT_ELEMENTS.has(name)) {
      const close = markup.toLowerCase().indexOf(`</${name}`, tagEnd + 1)
      const body = markup.slice(tagEnd + 1, close === -1 ? markup.length : close)
      if (name === "script" || name === "style") element.textContent = body
      else if (body) element.appendChild(new T0Text(body))
      // Appended WITHOUT connection hooks: parsed scripts run in document order by the page runner.
      element.parentNode = top()
      top().childNodes.push(element)
      const closeEnd = close === -1 ? -1 : markup.indexOf(">", close)
      at = closeEnd === -1 ? markup.length : closeEnd + 1
      continue
    }
    element.parentNode = top()
    top().childNodes.push(element)
    if (!VOID_ELEMENTS.has(name) && markup[tagEnd - 1] !== "/") stack.push(element)
    at = tagEnd + 1
  }
}

function findTagEnd(markup: string, from: number): number {
  let quote = ""
  for (let i = from + 1; i < markup.length; i += 1) {
    const ch = markup[i]
    if (quote) {
      if (ch === quote) quote = ""
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === ">") return i
  }
  return -1
}

function parseAttributes(raw: string): Map<string, string> {
  const out = new Map<string, string>()
  const pattern = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
  for (const match of raw.matchAll(pattern)) {
    const name = match[1]!.toLowerCase()
    if (out.has(name)) continue
    out.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""))
  }
  return out
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

// ---- selectors ---------------------------------------------------------------------------------

interface Compound {
  tag: string | null
  ids: string[]
  classes: string[]
  attrs: Array<{ name: string; op: string | null; value: string }>
  universal: boolean
}

type Step = { combinator: " " | ">"; compound: Compound }

const selectorCache = new Map<string, Step[][] | null>()

function parseSelectorList(selector: string): Step[][] | null {
  const cached = selectorCache.get(selector)
  if (cached !== undefined) return cached
  const groups: Step[][] = []
  for (const part of splitTopLevel(selector, ",")) {
    const steps = parseComplex(part.trim())
    if (!steps) {
      selectorCache.set(selector, null)
      return null
    }
    groups.push(steps)
  }
  selectorCache.set(selector, groups)
  return groups
}

function splitTopLevel(input: string, separator: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ""
  let current = ""
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = ""
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    if (ch === "[" || ch === "(") depth += 1
    if (ch === "]" || ch === ")") depth -= 1
    if (ch === separator && depth === 0) {
      out.push(current)
      current = ""
      continue
    }
    current += ch
  }
  out.push(current)
  return out
}

function parseComplex(input: string): Step[] | null {
  const steps: Step[] = []
  let at = 0
  let combinator: " " | ">" = " "
  while (at < input.length) {
    while (input[at] === " ") at += 1
    if (input[at] === ">") {
      combinator = ">"
      at += 1
      while (input[at] === " ") at += 1
    }
    const start = at
    let depth = 0
    let quote = ""
    while (at < input.length) {
      const ch = input[at]!
      if (quote) {
        if (ch === quote) quote = ""
      } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === "[") depth += 1
      else if (ch === "]") depth -= 1
      else if ((ch === " " || ch === ">") && depth === 0) break
      at += 1
    }
    const compound = parseCompound(input.slice(start, at))
    if (!compound) return null
    steps.push({ combinator, compound })
    combinator = " "
  }
  return steps.length ? steps : null
}

function parseCompound(input: string): Compound | null {
  const compound: Compound = { tag: null, ids: [], classes: [], attrs: [], universal: false }
  let rest = input
  const tag = /^([A-Za-z][A-Za-z0-9-]*|\*)/.exec(rest)
  if (tag) {
    if (tag[1] === "*") compound.universal = true
    else compound.tag = tag[1]!.toLowerCase()
    rest = rest.slice(tag[0].length)
  }
  while (rest.length) {
    const id = /^#([A-Za-z0-9_-]+)/.exec(rest)
    if (id) {
      compound.ids.push(id[1]!)
      rest = rest.slice(id[0].length)
      continue
    }
    const cls = /^\.([A-Za-z0-9_-]+)/.exec(rest)
    if (cls) {
      compound.classes.push(cls[1]!)
      rest = rest.slice(cls[0].length)
      continue
    }
    const attr = /^\[\s*([A-Za-z0-9_:-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]/.exec(rest)
    if (attr) {
      compound.attrs.push({ name: attr[1]!.toLowerCase(), op: attr[2] ?? null, value: attr[3] ?? attr[4] ?? attr[5] ?? "" })
      rest = rest.slice(attr[0].length)
      continue
    }
    return null
  }
  return compound
}

function matchesCompound(node: T0Element, compound: Compound): boolean {
  if (compound.tag && node.localName !== compound.tag) return false
  for (const id of compound.ids) if (node.getAttribute("id") !== id) return false
  if (compound.classes.length) {
    const classes = (node.getAttribute("class") ?? "").split(/\s+/)
    for (const cls of compound.classes) if (!classes.includes(cls)) return false
  }
  for (const attr of compound.attrs) {
    const value = node.getAttribute(attr.name)
    if (value === null) return false
    switch (attr.op) {
      case null:
        break
      case "=":
        if (value !== attr.value) return false
        break
      case "^=":
        if (!value.startsWith(attr.value)) return false
        break
      case "$=":
        if (!value.endsWith(attr.value)) return false
        break
      case "*=":
        if (!value.includes(attr.value)) return false
        break
      case "~=":
        if (!value.split(/\s+/).includes(attr.value)) return false
        break
      case "|=":
        if (value !== attr.value && !value.startsWith(`${attr.value}-`)) return false
        break
      default:
        return false
    }
  }
  return true
}

function matchesSteps(node: T0Element, steps: Step[], index: number): boolean {
  const step = steps[index]!
  if (!matchesCompound(node, step.compound)) return false
  if (index === 0) return true
  if (step.combinator === ">") return node.parentNode ? matchesSteps(node.parentNode, steps, index - 1) : false
  let ancestor = node.parentNode
  while (ancestor) {
    if (matchesSteps(ancestor, steps, index - 1)) return true
    ancestor = ancestor.parentNode
  }
  return false
}

/** Selector matching for the subset T0 needs. An unsupported selector matches nothing (and never throws). */
export function matchesSelector(node: T0Element, selector: string): boolean {
  if (node.localName === "#fragment") return false
  const groups = parseSelectorList(String(selector))
  if (!groups) return false
  return groups.some((steps) => matchesSteps(node, steps, steps.length - 1))
}
