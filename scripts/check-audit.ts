import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUDIT_ARGS,
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
import { ROOT } from "./licenses.ts";

function fail(lines: string[]): never {
  for (const line of lines) console.error(line);
  process.exit(1);
}

const exceptions = parseExceptions(JSON.parse(readFileSync(join(ROOT, EXCEPTIONS_FILE), "utf8")));

const files = Object.fromEntries(
  SETTINGS_FILES.map((file) => {
    const path = join(ROOT, file);
    return [file, existsSync(path) ? readFileSync(path, "utf8") : undefined];
  }),
);
// The audit cannot see the repo's settings, but they still must not ignore advisories. The
// settings output holds registry tokens, so it is never printed.
const settings = spawnSync("pnpm", ["config", "list", "--json"], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
let resolved: unknown;
try {
  resolved = JSON.parse(settings.stdout);
} catch {
  fail([`pnpm config list --json gave no JSON (exit ${settings.status}).`, settings.stderr]);
}
const ignores = [...auditIgnoreSettings(files), ...resolvedAuditIgnores(resolved)];
if (ignores.length > 0)
  fail(["The dependency audit cannot run with audit ignores set:", ...ignores]);

console.log(`$ pnpm ${AUDIT_ARGS.join(" ")}`);
const folder = mkdtempSync(join(tmpdir(), "fft-audit-"));
let run: SpawnSyncReturns<string>;
try {
  writeFileSync(
    join(folder, "package.json"),
    auditManifest(readFileSync(join(ROOT, "package.json"), "utf8")),
  );
  copyFileSync(join(ROOT, "pnpm-lock.yaml"), join(folder, "pnpm-lock.yaml"));
  // pnpm exits 1 when it finds advisories, so the report decides, not the exit code.
  run = spawnSync("pnpm", AUDIT_ARGS, {
    cwd: folder,
    env: auditEnv(process.env, folder),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
} finally {
  rmSync(folder, { recursive: true, force: true });
}
let report: unknown;
try {
  report = JSON.parse(run.stdout);
} catch {
  fail([`pnpm audit gave no JSON report (exit ${run.status}).`, run.stderr || run.stdout]);
}

const today = new Date().toISOString().slice(0, 10);
const { problems, excepted, stale } = checkAudit(parseAudit(report), exceptions, today);
for (const line of excepted) console.log(`Excepted: ${line}`);
for (const line of stale) console.warn(`Warning: ${line}`);
if (problems.length > 0) {
  fail([
    `The dependency audit found ${problems.length} problem(s):`,
    ...problems.map((problem) => `  ${problem}`),
  ]);
}
console.log("The dependency audit found no high or critical advisory without an exception.");
