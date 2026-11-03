import { isRecord, parseRecords } from "./records.ts";

export const EXCEPTIONS_FILE = "security/audit-exceptions.json";

// The public registry, whatever .npmrc or pnpm-workspace.yaml says, so a mirror cannot hide
// advisories.
export const AUDIT_ARGS = [
  "audit",
  "--prod",
  "--audit-level",
  "high",
  "--json",
  "--registry",
  "https://registry.npmjs.org/",
] as const;

// The audit runs in a new folder that holds only package.json and pnpm-lock.yaml, so no
// .npmrc or pnpm-workspace.yaml in the repo can route it through a proxy or turn off
// certificate checks. Its environment loses every pnpm and npm setting, the proxy and
// certificate variables, and the user's own settings folder.
const SETTING_VARIABLE =
  /^(?:(?:npm|pnpm)_config_\w*|(?:https?|all|no|ftp)_proxy|node_tls_reject_unauthorized|node_extra_ca_certs|ssl_cert_(?:file|dir))$/i;

export function auditEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const kept = Object.entries(env).filter(([key]) => !SETTING_VARIABLE.test(key));
  return { ...Object.fromEntries(kept), HOME: home, XDG_CONFIG_HOME: home };
}

const MANIFEST_FIELDS = [
  "name",
  "version",
  "dependencies",
  "devDependencies",
  "optionalDependencies",
] as const;

// The audit folder's package.json: the dependency lists and nothing that pnpm reads as a
// setting.
export function auditManifest(text: string): string {
  const manifest: unknown = JSON.parse(text);
  if (!isRecord(manifest)) throw new Error("package.json is not a JSON object.");
  const kept = MANIFEST_FIELDS.filter((field) => manifest[field] !== undefined);
  return `${JSON.stringify(Object.fromEntries(kept.map((field) => [field, manifest[field]])), null, 2)}\n`;
}

const BLOCKING = new Set(["high", "critical"]);

export type AuditException = Record<"advisory" | "package" | "reason" | "expires", string>;

export type Advisory = {
  id: string;
  package: string;
  severity: string;
  title: string;
  url: string;
  hasFix: boolean;
};

export function parseExceptions(json: unknown): AuditException[] {
  const records = parseRecords(
    json,
    EXCEPTIONS_FILE,
    ["advisory", "package", "reason", "expires"],
    ["expires"],
  );
  for (const [index, record] of records.entries()) {
    if (!/^GHSA(?:-[0-9a-z]{4}){3}$/.test(record.advisory)) {
      throw new Error(
        `Record ${index + 1} in ${EXCEPTIONS_FILE} needs "advisory" as a GHSA ID, not "${record.advisory}".`,
      );
    }
  }
  return records;
}

// Reads the output of `pnpm audit --json`.
export function parseAudit(json: unknown): Advisory[] {
  if (!isRecord(json) || !isRecord(json.advisories)) {
    throw new Error("pnpm audit --json gave no advisories object.");
  }
  return Object.values(json.advisories).map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.github_advisory_id !== "string" ||
      typeof entry.module_name !== "string" ||
      typeof entry.severity !== "string"
    ) {
      throw new Error("pnpm audit --json gave an advisory without an ID, package, or severity.");
    }
    const patched = entry.patched_versions;
    return {
      id: entry.github_advisory_id,
      package: entry.module_name,
      severity: entry.severity,
      title: typeof entry.title === "string" ? entry.title : "",
      url: typeof entry.url === "string" ? entry.url : "",
      // npm writes "<0.0.0" and pnpm writes null when no version fixes the advisory.
      hasFix: typeof patched === "string" && patched.trim() !== "" && patched !== "<0.0.0",
    };
  });
}

export const MAX_EXCEPTION_DAYS = 90;

function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

// today is a YYYY-MM-DD date. An exception holds through its expiry date.
export function checkAudit(
  advisories: readonly Advisory[],
  exceptions: readonly AuditException[],
  today: string,
): { problems: string[]; excepted: string[]; stale: string[] } {
  const problems: string[] = [];
  const excepted: string[] = [];
  const latest = addDays(today, MAX_EXCEPTION_DAYS);
  for (const exception of exceptions) {
    if (exception.expires > latest) {
      problems.push(
        `The exception for ${exception.advisory} in ${exception.package} expires on ${exception.expires}. Set a date no more than ${MAX_EXCEPTION_DAYS} days ahead, by ${latest}.`,
      );
    }
  }
  for (const advisory of advisories) {
    if (!BLOCKING.has(advisory.severity)) continue;
    const name = `${advisory.id} (${advisory.severity}) in ${advisory.package}: ${advisory.title} ${advisory.url}`;
    const exception = exceptions.find(
      (record) => record.advisory === advisory.id && record.package === advisory.package,
    );
    if (exception === undefined) {
      problems.push(name);
    } else if (advisory.hasFix) {
      problems.push(`${name}. A fix exists, so upgrade instead of keeping the exception.`);
    } else if (exception.expires < today) {
      problems.push(`${name}. Its exception expired on ${exception.expires}.`);
    } else {
      excepted.push(`${name}. Excepted until ${exception.expires}: ${exception.reason}`);
    }
  }
  const stale = exceptions
    .filter(
      (record) =>
        !advisories.some(
          (advisory) => advisory.id === record.advisory && advisory.package === record.package,
        ),
    )
    .map(
      (record) =>
        `The exception for ${record.advisory} in ${record.package} matches no current advisory. Remove it from ${EXCEPTIONS_FILE}.`,
    );
  return { problems, excepted, stale };
}

// Only security/audit-exceptions.json may let an advisory pass. pnpm also takes advisory
// ignores from its settings: auditConfig or audit in pnpm-workspace.yaml, and pnpm_config_*
// variables, under names it may change. So both the settings files and the settings pnpm
// resolves must hold none.
export const SETTINGS_FILES = ["pnpm-workspace.yaml", ".npmrc", "package.json"] as const;

const IGNORE_KEY = /^(?:audit(?:[-_.]?(?:config|ignore))?|ignore[-_]?(?:ghsas|cves|unfixable))$/i;
const KEY = /(?:^|[\s{,])["']?([\w.-]+)["']?[ \t]*(?:\[\])?[ \t]*[:=]/gm;

function jsonKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(jsonKeys);
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, inner]) => [key, ...jsonKeys(inner)]);
}

// files maps each name in SETTINGS_FILES to its text, or to undefined when it is absent.
export function auditIgnoreSettings(files: Readonly<Record<string, string | undefined>>): string[] {
  const problems: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    if (text === undefined) continue;
    let keys: string[];
    if (file === "package.json") {
      const manifest: unknown = JSON.parse(text);
      // pnpm reads its settings from the "pnpm" field, and npm from the top level.
      keys = isRecord(manifest) ? [...Object.keys(manifest), ...jsonKeys(manifest.pnpm)] : [];
    } else {
      keys = [...text.matchAll(KEY)].map((match) => match[1] as string);
    }
    for (const key of new Set(keys.filter((key) => IGNORE_KEY.test(key)))) {
      problems.push(`${file} sets "${key}". Put audit exceptions in ${EXCEPTIONS_FILE} instead.`);
    }
  }
  return problems;
}

// config is the output of `pnpm config list --json`, which also holds registry tokens, so
// this reads only the audit settings.
export function resolvedAuditIgnores(config: unknown): string[] {
  if (!isRecord(config)) throw new Error("pnpm config list --json gave no settings object.");
  return Object.entries(config)
    .filter(([key, value]) => IGNORE_KEY.test(key) && value !== null && value !== undefined)
    .map(
      ([key, value]) =>
        `pnpm resolves the setting "${key}" to ${JSON.stringify(value)}. Remove it, and put audit exceptions in ${EXCEPTIONS_FILE}.`,
    );
}
