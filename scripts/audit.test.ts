import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AUDIT_ARGS,
  type AuditException,
  auditEnv,
  auditIgnoreSettings,
  auditManifest,
  checkAudit,
  EXCEPTIONS_FILE,
  parseAudit,
  parseExceptions,
  resolvedAuditIgnores,
  SETTINGS_FILES,
} from "./audit.ts";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

const advisories = parseAudit(readJson("./fixtures/pnpm-audit.json"));
const TODAY = "2026-11-03";

const ipException: AuditException = {
  advisory: "GHSA-2p57-rm9w-gvfp",
  package: "ip",
  reason: "Only isPublic is affected, and the app never calls it.",
  expires: "2026-12-01",
};

const failedIds = (problems: string[]) => problems.map((problem) => problem.split(" ")[0]);

describe("checkAudit on fixture JSON", () => {
  it("fails each high or critical advisory and names it, and passes moderate ones", () => {
    const { problems, excepted } = checkAudit(advisories, [], TODAY);

    expect(failedIds(problems).sort()).toEqual([
      "GHSA-2p57-rm9w-gvfp",
      "GHSA-35jh-r3h4-6jhm",
      "GHSA-xvch-5gv4-984h",
    ]);
    expect(problems).toContain(
      "GHSA-xvch-5gv4-984h (critical) in minimist: Prototype Pollution in minimist https://github.com/advisories/GHSA-xvch-5gv4-984h",
    );
    expect(excepted).toEqual([]);
  });

  it("passes an advisory with no fix that has an exception", () => {
    const { problems, excepted } = checkAudit(advisories, [ipException], TODAY);

    expect(failedIds(problems)).not.toContain("GHSA-2p57-rm9w-gvfp");
    expect(excepted).toEqual([expect.stringMatching(/^GHSA-2p57-rm9w-gvfp .* until 2026-12-01/)]);
  });

  it("passes an exception through its expiry date, and fails it the day after", () => {
    const exception = { ...ipException, expires: TODAY };

    expect(checkAudit(advisories, [exception], TODAY).excepted).toHaveLength(1);
    expect(checkAudit(advisories, [exception], "2026-11-04").problems).toContainEqual(
      expect.stringMatching(/^GHSA-2p57-rm9w-gvfp .*expired on 2026-11-03\.$/),
    );
  });

  it("fails an advisory with a fix even when it has an exception", () => {
    const exception = { ...ipException, advisory: "GHSA-35jh-r3h4-6jhm", package: "lodash" };
    const { problems, excepted } = checkAudit(advisories, [exception], TODAY);

    expect(problems).toContainEqual(expect.stringMatching(/^GHSA-35jh-r3h4-6jhm .*A fix exists/));
    expect(excepted).toEqual([]);
  });

  it("applies an exception only to its own package", () => {
    const exception = { ...ipException, package: "lodash" };

    expect(failedIds(checkAudit(advisories, [exception], TODAY).problems)).toContain(
      "GHSA-2p57-rm9w-gvfp",
    );
  });

  it("fails an exception that expires more than 90 days ahead", () => {
    const at = (expires: string) =>
      checkAudit(advisories, [{ ...ipException, expires }], TODAY).problems.filter((problem) =>
        problem.startsWith("The exception"),
      );

    expect(at("2027-02-01")).toEqual([]);
    expect(at("2099-12-31")).toEqual([
      "The exception for GHSA-2p57-rm9w-gvfp in ip expires on 2099-12-31. Set a date no more than 90 days ahead, by 2027-02-01.",
    ]);
  });

  it("warns about an exception that matches no current advisory", () => {
    const gone = { ...ipException, advisory: "GHSA-aaaa-bbbb-cccc" };

    expect(checkAudit(advisories, [ipException, gone], TODAY).stale).toEqual([
      "The exception for GHSA-aaaa-bbbb-cccc in ip matches no current advisory. Remove it from security/audit-exceptions.json.",
    ]);
  });
});

describe("audit ignore settings", () => {
  it("leaves pnpm's audit on the public registry", () => {
    expect(AUDIT_ARGS.join(" ")).toContain("--registry https://registry.npmjs.org/");
  });

  it("finds none in this repo", () => {
    const files = Object.fromEntries(
      SETTINGS_FILES.map((file) => {
        const url = new URL(`../${file}`, import.meta.url);
        return [file, existsSync(url) ? readFileSync(url, "utf8") : undefined];
      }),
    );

    expect(auditIgnoreSettings(files)).toEqual([]);
  });

  it.each([
    [
      "pnpm-workspace.yaml",
      "auditConfig:\n  ignoreGhsas:\n    - GHSA-2p57-rm9w-gvfp\n",
      ["auditConfig", "ignoreGhsas"],
    ],
    ["pnpm-workspace.yaml", "audit:\n  ignore: [GHSA-2p57-rm9w-gvfp]\n", ["audit"]],
    [
      "pnpm-workspace.yaml",
      '{"auditConfig": {ignoreCves: [CVE-2024-29415]}}\n',
      ["auditConfig", "ignoreCves"],
    ],
    [".npmrc", "ignore-unfixable=true\n", ["ignore-unfixable"]],
    [
      ".npmrc",
      'audit-config={"ignoreGhsas":["GHSA-2p57-rm9w-gvfp"]}\n',
      ["audit-config", "ignoreGhsas"],
    ],
    [".npmrc", "audit.ignore[]=GHSA-2p57-rm9w-gvfp\n", ["audit.ignore"]],
    [
      "package.json",
      '{"name": "a", "pnpm": {"auditConfig": {"ignoreGhsas": ["GHSA-2p57-rm9w-gvfp"]}}}',
      ["auditConfig", "ignoreGhsas"],
    ],
    ["package.json", '{"name": "a", "\\u0061uditConfig": {}}', ["auditConfig"]],
  ])("fails an ignore in %s: %j", (file, text, keys) => {
    expect(auditIgnoreSettings({ [file]: text })).toEqual(
      keys.map(
        (key) =>
          `${file} sets "${key}". Put audit exceptions in security/audit-exceptions.json instead.`,
      ),
    );
  });

  it("passes settings that only look alike", () => {
    expect(
      auditIgnoreSettings({
        "pnpm-workspace.yaml": "ignoredBuiltDependencies:\n  - esbuild\n",
        ".npmrc": "ignore-scripts=true\naudit-level=high\n",
        "package.json": '{"scripts": {"check:audit": "node scripts/check-audit.ts"}}',
      }),
    ).toEqual([]);
  });

  it("fails an ignore that pnpm resolves from anywhere, and prints no other setting", () => {
    const problems = resolvedAuditIgnores({
      "//registry.npmjs.org/:_authToken": "npm_not-a-real-token",
      registry: "https://registry.npmjs.org/",
      audit: { ignore: ["GHSA-2p57-rm9w-gvfp"] },
    });

    expect(problems).toEqual([
      'pnpm resolves the setting "audit" to {"ignore":["GHSA-2p57-rm9w-gvfp"]}. Remove it, and put audit exceptions in security/audit-exceptions.json.',
    ]);
  });

  it("passes resolved settings with no audit ignore", () => {
    expect(resolvedAuditIgnores({ registry: "https://registry.npmjs.org/", audit: null })).toEqual(
      [],
    );
  });
});

describe("the audit's own folder", () => {
  it("gets an environment with no pnpm or npm settings, proxies, or certificate overrides", () => {
    const env = auditEnv(
      {
        PATH: "/usr/bin",
        PNPM_HOME: "/opt/pnpm",
        HOME: "/home/runner",
        XDG_CONFIG_HOME: "/home/runner/.config",
        npm_config_https_proxy: "http://127.0.0.1:8888/",
        NPM_CONFIG_STRICT_SSL: "false",
        pnpm_config_audit_config: '{"ignoreGhsas":["GHSA-2p57-rm9w-gvfp"]}',
        PNPM_CONFIG_REGISTRY: "http://127.0.0.1:8888/",
        HTTPS_PROXY: "http://127.0.0.1:8888/",
        http_proxy: "http://127.0.0.1:8888/",
        ALL_PROXY: "socks5://127.0.0.1:1080/",
        no_proxy: "registry.npmjs.org",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        NODE_EXTRA_CA_CERTS: "/tmp/proxy-ca.pem",
        SSL_CERT_FILE: "/tmp/proxy-ca.pem",
      },
      "/tmp/fft-audit-x",
    );

    expect(env).toEqual({
      PATH: "/usr/bin",
      PNPM_HOME: "/opt/pnpm",
      HOME: "/tmp/fft-audit-x",
      XDG_CONFIG_HOME: "/tmp/fft-audit-x",
    });
  });

  it("gets a package.json with the dependency lists and none of pnpm's settings", () => {
    const manifest = {
      name: "family-finance-tracker",
      version: "0.0.0",
      packageManager: "pnpm@12.9.0",
      dependencies: { hono: "4.13.16" },
      devDependencies: { vite: "8.3.5" },
      pnpm: { httpsProxy: "http://127.0.0.1:8888/", strictSsl: false },
      scripts: { preinstall: "node evil.js" },
    };

    expect(JSON.parse(auditManifest(JSON.stringify(manifest)))).toEqual({
      name: "family-finance-tracker",
      version: "0.0.0",
      dependencies: { hono: "4.13.16" },
      devDependencies: { vite: "8.3.5" },
    });
  });
});

describe("parseAudit", () => {
  it("reads a missing fix from pnpm's null and npm's <0.0.0", () => {
    const fix = Object.fromEntries(advisories.map((advisory) => [advisory.id, advisory.hasFix]));

    expect(fix).toEqual({
      "GHSA-2p57-rm9w-gvfp": false,
      "GHSA-35jh-r3h4-6jhm": true,
      "GHSA-xvch-5gv4-984h": true,
      "GHSA-p8p7-x288-28g6": false,
    });
  });

  it.each([
    ["an error report", { error: { code: "ERR_PNPM_AUDIT_BAD_RESPONSE" } }],
    ["an advisory with no ID", { advisories: { 1: { module_name: "a", severity: "high" } } }],
  ])("refuses %s", (_case, json) => {
    expect(() => parseAudit(json)).toThrow(/pnpm audit --json/);
  });
});

describe(EXCEPTIONS_FILE, () => {
  it("is a valid list of exceptions", () => {
    expect(() => parseExceptions(readJson(`../${EXCEPTIONS_FILE}`))).not.toThrow();
  });

  it.each([
    ["an advisory that is not a GHSA ID", { ...ipException, advisory: "CVE-2024-29415" }, /GHSA/],
    ["a missing reason", { ...ipException, reason: "" }, /needs "reason"/],
    ["an expiry that is not a date", { ...ipException, expires: "next month" }, /YYYY-MM-DD/],
  ])("refuses %s", (_case, record, message) => {
    expect(() => parseExceptions([record])).toThrow(message);
  });
});
