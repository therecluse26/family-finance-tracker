import type { TestMember } from "../auth/testing.ts";
import type { createApp } from "./app.ts";

// Test support: a browser that talks to the app through its HTTP interface, in plain-HTTP mode.

export type App = ReturnType<typeof createApp>;

// One browser at one client address, with its own cookies.
export class TestBrowser {
  readonly cookies = new Map<string, string>();
  private readonly app: App;
  private readonly appUrl: URL;
  readonly client: string;

  constructor(app: App, appUrl: string, client: string) {
    this.app = app;
    this.appUrl = new URL(appUrl);
    this.client = client;
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
      { incoming: { socket: { remoteAddress: this.client } } },
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
