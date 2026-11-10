import { request as httpRequest } from "node:http";
import { crc32, inflateRawSync } from "node:zlib";
import type { TestMember } from "../auth/testing.ts";
import type { createApp } from "./app.ts";

// Test support: a browser that talks to the app through its HTTP interface, in plain-HTTP mode, or
// in HTTPS mode through a trusted proxy.

export type App = ReturnType<typeof createApp>;

// One browser at one client address, with its own cookies.
export class TestBrowser {
  readonly cookies = new Map<string, string>();
  private readonly app: App;
  private readonly appUrl: URL;
  readonly client: string;
  // In HTTPS mode, the trusted proxy's address and the headers it adds to each request.
  private readonly proxy: { source: string; headers: Record<string, string> } | undefined;

  constructor(
    app: App,
    appUrl: string,
    client: string,
    proxy?: { source: string; headers: Record<string, string> },
  ) {
    this.app = app;
    this.appUrl = new URL(appUrl);
    this.client = client;
    this.proxy = proxy;
  }

  // `headers` replace the browser's own, such as an Origin from another site. A header set to
  // undefined is not sent at all.
  async send(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string | undefined> = {},
  ): Promise<Response> {
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    const sent: Record<string, string | undefined> = {
      host: this.appUrl.host,
      origin: this.appUrl.origin,
      ...this.proxy?.headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie === "" ? {} : { cookie }),
      ...headers,
    };
    const res = await this.app.request(
      `${this.appUrl.origin}${path}`,
      {
        method,
        headers: Object.fromEntries(
          Object.entries(sent).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      { incoming: { socket: { remoteAddress: this.proxy?.source ?? this.client } } },
    );
    for (const line of res.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (/max-age=0/i.test(line) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  // A raw body, such as a file upload, with its Content-Type. A stream is sent as it comes.
  async upload(
    path: string,
    body: Uint8Array | string | ReadableStream<Uint8Array>,
    contentType: string | undefined,
    headers: Record<string, string | undefined> = {},
  ): Promise<Response> {
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    const sent: Record<string, string | undefined> = {
      host: this.appUrl.host,
      origin: this.appUrl.origin,
      ...this.proxy?.headers,
      "content-type": contentType,
      ...(cookie === "" ? {} : { cookie }),
      ...headers,
    };
    return this.app.request(
      `${this.appUrl.origin}${path}`,
      {
        method: "POST",
        headers: Object.fromEntries(
          Object.entries(sent).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        body: body as RequestInit["body"],
        ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
      } as RequestInit,
      { incoming: { socket: { remoteAddress: this.proxy?.source ?? this.client } } },
    );
  }

  post = (path: string, body: unknown = {}) => this.send("POST", path, body);
  get = (path: string) => this.send("GET", path);

  // Signs the Member in with the password, then a TOTP code.
  async signIn(member: TestMember): Promise<void> {
    const password = await this.post("/api/auth/sign-in/email", {
      email: member.email,
      password: member.password,
    });
    if (password.status !== 200) throw new Error(`The password step answered ${password.status}.`);
    const code = await this.post("/api/auth/two-factor/verify-totp", {
      code: await member.totpCode(),
    });
    if (code.status !== 200) throw new Error(`The code step answered ${code.status}.`);
  }

  async isSignedIn(): Promise<boolean> {
    return (await this.get("/api/ping")).status === 200;
  }
}

// Each file in a .zip archive, by name, in the order the directory lists them. It checks what a
// strict reader checks: each local header matches the directory, each data descriptor follows its
// data, each CRC-32 and size is right, and the directory ends the archive.
export function readZip(archive: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = archive.length - 22;
  if (view.getUint32(end, true) !== 0x06054b50) throw new Error("No end of the .zip directory.");
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  let at = view.getUint32(end + 16, true);
  if (at + directorySize !== end) throw new Error("The .zip directory does not end the archive.");
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("The .zip directory is broken.");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      archive.subarray(at + 46, at + 46 + nameLength),
    );
    if (view.getUint32(local, true) !== 0x04034b50) throw new Error(`${name}: no local header.`);
    if (view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method) {
      throw new Error(`${name}: the local header does not match the directory.`);
    }
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = archive.subarray(start, start + compressed);
    const content = method === 8 ? new Uint8Array(inflateRawSync(data)) : data;
    if (content.length !== size || crc32(content) !== crc) {
      throw new Error(`${name}: the size or CRC-32 is wrong.`);
    }
    if (flags & 0x0008) {
      const descriptor = start + compressed;
      if (
        view.getUint32(descriptor, true) !== 0x08074b50 ||
        view.getUint32(descriptor + 4, true) !== crc ||
        view.getUint32(descriptor + 8, true) !== compressed ||
        view.getUint32(descriptor + 12, true) !== size
      ) {
        throw new Error(`${name}: the data descriptor is wrong.`);
      }
    }
    files.set(name, content);
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return files;
}

// A fetch for a running server that sends `host` as the Host header, as a proxy in front of the
// app does with the APP_URL host. Node's own fetch always sends the host of the URL it is given.
export function fetchWithHost(host: string): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    return new Promise<Response>((resolve, reject) => {
      const sent = httpRequest(
        request.url,
        { method: request.method, headers: { ...Object.fromEntries(request.headers), host } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              for (const one of Array.isArray(value) ? value : [value ?? ""]) {
                headers.append(name, one);
              }
            }
            const status = res.statusCode ?? 500;
            const empty = [204, 304].includes(status) || request.method === "HEAD";
            resolve(new Response(empty ? null : Buffer.concat(chunks), { status, headers }));
          });
        },
      );
      sent.on("error", reject);
      sent.end(body);
    });
  };
}
