export const META_GRAPH_BATCH_MAX = 50;
export const META_GRAPH_BATCH_OUTER_MAX_BYTES = 16 * 1024 * 1024;
export const META_GRAPH_BATCH_ITEM_MAX_BYTES = 8 * 1024 * 1024;

export interface MetaGraphBatchRead {
  key: string;
  relativeUrl: string;
}

export interface MetaGraphBatchResult {
  key: string;
  status: number;
  headers: Headers;
  body: unknown;
}

export interface MetaGraphBatchEnvelope {
  outerStatus: number;
  outerHeaders: Headers;
  results: MetaGraphBatchResult[];
}

export class MetaGraphBatchTransportError extends Error {
  readonly status: number | null;
  readonly headers: Headers;
  readonly providerCode: number | null;
  readonly providerSubcode: number | null;
  readonly aborted: boolean;

  constructor(input: {
    message: string;
    status?: number | null;
    headers?: Headers;
    providerCode?: number | null;
    providerSubcode?: number | null;
    aborted?: boolean;
  }) {
    super(input.message);
    this.name = "MetaGraphBatchTransportError";
    this.status = input.status ?? null;
    this.headers = new Headers(input.headers);
    this.providerCode = input.providerCode ?? null;
    this.providerSubcode = input.providerSubcode ?? null;
    this.aborted = input.aborted ?? false;
  }
}

function numericField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function providerCodes(body: unknown): { providerCode: number | null; providerSubcode: number | null } {
  if (!body || typeof body !== "object") return { providerCode: null, providerSubcode: null };
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return { providerCode: null, providerSubcode: null };
  const record = error as Record<string, unknown>;
  return {
    providerCode: numericField(record.code),
    providerSubcode: numericField(record.error_subcode),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function itemHeaders(value: unknown): Headers {
  const headers = new Headers();
  if (!Array.isArray(value)) return headers;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { name, value: headerValue } = item as { name?: unknown; value?: unknown };
    if (typeof name === "string" && typeof headerValue === "string") headers.append(name, headerValue);
  }
  return headers;
}

function validateReads(reads: readonly MetaGraphBatchRead[]): void {
  if (reads.length < 1 || reads.length > META_GRAPH_BATCH_MAX) {
    throw new MetaGraphBatchTransportError({ message: `Meta Graph batch requires 1-${META_GRAPH_BATCH_MAX} GET reads` });
  }
  const keys = new Set<string>();
  for (const read of reads) {
    const relativeUrl = read.relativeUrl.trim();
    let parsed: URL;
    try {
      parsed = new URL(relativeUrl, "https://graph.facebook.com/");
    } catch {
      throw new MetaGraphBatchTransportError({ message: "Meta Graph batch contains an unsafe relative GET URL" });
    }
    const hasAccessToken = [...parsed.searchParams.keys()].some(key => key.toLowerCase() === "access_token");
    if (!read.key || keys.has(read.key) || !relativeUrl || /[\u0000-\u001f\u007f]/.test(read.relativeUrl)
      || parsed.origin !== "https://graph.facebook.com" || /^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(relativeUrl) || hasAccessToken) {
      throw new MetaGraphBatchTransportError({ message: "Meta Graph batch contains an unsafe relative GET URL" });
    }
    keys.add(read.key);
  }
}

async function readOuterBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > META_GRAPH_BATCH_OUTER_MAX_BYTES) {
        await reader.cancel();
        throw new MetaGraphBatchTransportError({
          message: "Meta Graph batch response exceeded the byte limit",
          status: response.status,
          headers: response.headers,
        });
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof MetaGraphBatchTransportError) throw error;
    const aborted = error instanceof DOMException
      ? error.name === "AbortError"
      : error instanceof Error && error.name === "AbortError";
    throw new MetaGraphBatchTransportError({
      message: aborted ? "Meta Graph batch response stream was aborted" : "Meta Graph batch response stream failed",
      status: response.status,
      headers: response.headers,
      aborted,
    });
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function executeMetaGraphReadBatch(input: {
  apiVersion: string;
  accessToken: string;
  reads: readonly MetaGraphBatchRead[];
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  onOuterResponse?: (response: { status: number; headers: Headers }) => Promise<void> | void;
}): Promise<MetaGraphBatchEnvelope> {
  validateReads(input.reads);
  if (!/^v\d+\.\d+$/.test(input.apiVersion) || !input.accessToken) {
    throw new MetaGraphBatchTransportError({ message: "Meta Graph batch credentials or API version are invalid" });
  }

  const form = new URLSearchParams();
  form.set("access_token", input.accessToken);
  form.set("batch", JSON.stringify(input.reads.map((read) => ({ method: "GET", relative_url: read.relativeUrl }))));

  let response: Response;
  try {
    response = await (input.fetcher ?? fetch)(`https://graph.facebook.com/${input.apiVersion}/`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: input.signal,
    });
  } catch (error) {
    const aborted = error instanceof DOMException
      ? error.name === "AbortError"
      : error instanceof Error && error.name === "AbortError";
    throw new MetaGraphBatchTransportError({
      message: aborted ? "Meta Graph batch transport was aborted" : "Meta Graph batch transport failed before a response",
      aborted,
    });
  }

  await input.onOuterResponse?.({ status: response.status, headers: response.headers });
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > META_GRAPH_BATCH_OUTER_MAX_BYTES) {
    throw new MetaGraphBatchTransportError({ message: "Meta Graph batch response exceeded the byte limit", status: response.status, headers: response.headers });
  }
  const text = await readOuterBody(response);
  const parsed = parseJson(text);

  if (!response.ok) {
    throw new MetaGraphBatchTransportError({
      message: `Meta Graph batch transport returned HTTP ${response.status}`,
      status: response.status,
      headers: response.headers,
      ...providerCodes(parsed),
    });
  }
  if (!Array.isArray(parsed) || parsed.length !== input.reads.length) {
    throw new MetaGraphBatchTransportError({ message: "Meta Graph batch response was malformed", status: response.status, headers: response.headers });
  }

  const results = input.reads.map((read, index): MetaGraphBatchResult => {
    const item = parsed[index];
    if (!item || typeof item !== "object") {
      throw new MetaGraphBatchTransportError({ message: "Meta Graph batch item was malformed", status: response.status, headers: response.headers });
    }
    const record = item as Record<string, unknown>;
    const status = numericField(record.code);
    const bodyText = typeof record.body === "string" ? record.body : null;
    if (status === null || bodyText === null) {
      throw new MetaGraphBatchTransportError({ message: "Meta Graph batch item was malformed", status: response.status, headers: response.headers });
    }
    if (byteLength(bodyText) > META_GRAPH_BATCH_ITEM_MAX_BYTES) {
      throw new MetaGraphBatchTransportError({ message: "Meta Graph batch item exceeded the byte limit", status: response.status, headers: response.headers });
    }
    return {
      key: read.key,
      status,
      headers: itemHeaders(record.headers),
      body: parseJson(bodyText),
    };
  });

  return { outerStatus: response.status, outerHeaders: response.headers, results };
}
