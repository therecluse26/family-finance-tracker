import { PriceSourceError } from "../adapter.ts";

// The one way a reader calls a Price source. It follows no redirect, since a redirect to another
// host would carry the key. It reads at most 8 MB of an answer, and gives up after its timeout.
// Every failure becomes a PriceSourceError with a fixed message: no raw error, status text or
// answer body leaves it, since one can hold a key or a request (K8).

const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

export type SourceAnswer = { status: number; body: unknown };

// Tests and dev runs reach only the local fake servers. Under Vitest, a call to any other host
// throws before it is sent, so no test can reach Apify or Kroger by mistake.
function refuseOutsideCallInTests(url: URL): void {
  if (process.env.VITEST !== undefined && url.hostname !== "127.0.0.1") {
    throw new PriceSourceError("store failed", "A test may call only a local fake server.");
  }
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel();
      throw new PriceSourceError("store failed", "The Price source sent too large an answer.");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// Sends one request and reads its JSON answer, whatever its status. A body that is not JSON reads
// as null.
export async function callSource(
  url: URL,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<SourceAnswer> {
  refuseOutsideCallInTests(url);
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await readCapped(response);
  } catch (error) {
    if (error instanceof PriceSourceError) throw error;
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new PriceSourceError("timed out", "The Price source took too long to answer.");
    }
    throw new PriceSourceError("store failed", "The Price source could not be reached.");
  }
  let body: unknown = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const recordsIn = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];
