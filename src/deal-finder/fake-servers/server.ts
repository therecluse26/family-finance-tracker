import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

// Test and dev support: a local JSON server on 127.0.0.1, which a Price source reader talks to in
// place of the real service. It records every request, so a test can see exactly what was sent.
// Every answer is made up by hand. Like src/bank/fake-plaid.ts.

// An answer: a JSON body with a status, a dropped connection, or no answer at all until the server
// closes.
export type FakeAnswer = { status?: number; body: unknown } | "hang up" | "hang";

export type FakeRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingHttpHeaders;
  // The body as sent, and parsed when it is JSON.
  text: string;
  body: unknown;
};

export abstract class FakeJsonServer {
  readonly requests: FakeRequest[] = [];
  // While set, every request waits for it before its answer, so a test can hold calls in flight.
  hold: Promise<void> | undefined;
  // The most requests that were in flight at once.
  mostAtOnce = 0;
  private inFlight = 0;
  // Answers that replace the server's own, for each path that starts with the key. Each answers in
  // order; its last repeats.
  private readonly overrides = new Map<string, FakeAnswer[]>();
  private readonly hanging = new Set<() => void>();
  private readonly server: Server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
    });
    req.on("end", () => {
      void this.respond(req.method ?? "GET", req.url ?? "/", req.headers, text, res);
    });
  });
  private address: string | undefined;

  protected abstract answerFor(request: FakeRequest): FakeAnswer;

  // Replaces the answer for each path that starts with `pathStart`.
  answer(pathStart: string, ...answers: FakeAnswer[]): void {
    this.overrides.set(pathStart, answers);
  }

  // The requests to paths that start with `pathStart`.
  to(pathStart: string): FakeRequest[] {
    return this.requests.filter((request) => request.path.startsWith(pathStart));
  }

  get url(): string {
    if (this.address === undefined) throw new Error("Start the fake server first.");
    return this.address;
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.address = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.address;
  }

  close(): Promise<unknown> {
    for (const release of this.hanging) release();
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(resolve));
  }

  private async respond(
    method: string,
    rawUrl: string,
    headers: IncomingHttpHeaders,
    text: string,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(rawUrl, "http://127.0.0.1");
    let body: unknown = null;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    const request: FakeRequest = {
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers,
      text,
      body,
    };
    this.requests.push(request);
    this.inFlight += 1;
    this.mostAtOnce = Math.max(this.mostAtOnce, this.inFlight);
    try {
      if (this.hold !== undefined) await this.hold;
      const answer = this.overrideFor(request.path) ?? this.answerFor(request);
      if (answer === "hang up") {
        res.socket?.destroy();
      } else if (answer === "hang") {
        await new Promise<void>((resolve) => this.hanging.add(resolve));
        res.destroy();
      } else {
        res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.body));
      }
    } finally {
      this.inFlight -= 1;
    }
  }

  private overrideFor(path: string): FakeAnswer | undefined {
    for (const [start, queue] of this.overrides) {
      if (!path.startsWith(start)) continue;
      return queue.length > 1 ? queue.shift() : queue[0];
    }
    return undefined;
  }
}
