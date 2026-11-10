import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "vite";
import { describe, expect, it } from "vitest";

// The "Module seams" table in docs/spec/10-stack-and-architecture.md.
// Each module under src/ is the sole importer of its packages. "@scope/*" means every package
// in that scope, so `ai` owns every AI provider package, such as @ai-sdk/gateway.
const SEAMS: Record<string, readonly string[]> = {
  db: ["drizzle-orm", "@libsql/client"],
  jobs: ["sidequest", "@sidequest/*"],
  bank: ["plaid"],
  ai: ["ai", "@ai-sdk/*", "@openrouter/*"],
  secrets: ["node:crypto"],
  notify: ["web-push", "nodemailer"],
  auth: ["better-auth", "@better-auth/*"],
};

// The Chat page's answer stream in the browser. It is not an AI provider package.
const OWNED_BY_NONE = new Set(["@ai-sdk/react"]);

// Synchronous SQLite drivers. Every query goes through @libsql/client in src/db, and is awaited.
// node:module holds createRequire, which loads packages past this check.
const IMPORTED_BY_NONE = new Set(["libsql", "better-sqlite3", "node:sqlite", "node:module"]);

// Drizzle's driver entry points, such as drizzle-orm/better-sqlite3, are its folders that hold a
// driver.js. Only its libSQL driver may be used.
const DRIZZLE = fileURLToPath(new URL("../node_modules/drizzle-orm", import.meta.url));
const OTHER_DRIZZLE_DRIVERS = new Set(
  readdirSync(DRIZZLE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(DRIZZLE, entry.name, "driver.js")))
    .map((entry) => entry.name)
    .filter((name) => name !== "libsql"),
);

function importedByNone(specifier: string): boolean {
  const pkg = packageName(specifier);
  if (pkg !== undefined && IMPORTED_BY_NONE.has(pkg)) return true;
  const [name, entry = ""] = specifier.split("/");
  return name === "drizzle-orm" && OTHER_DRIZZLE_DRIVERS.has(entry);
}

function ownerOf(pkg: string): string | undefined {
  if (OWNED_BY_NONE.has(pkg)) return undefined;
  const owns = (pattern: string) =>
    pattern.endsWith("/*") ? pkg.startsWith(pattern.slice(0, -1)) : pkg === pattern;
  return Object.keys(SEAMS).find((module) => SEAMS[module]?.some(owns));
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// spikes/ holds throwaway probe scripts that run outside the app, so no module seam applies to them.
const SKIPPED_DIRS = new Set(["node_modules", "dist", "coverage", "spikes"]);
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

type SourceFile = { path: string; code: string };

function packageName(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
  const bare = specifier.replace(/^node:/, "");
  const [first = "", second = ""] = bare.split("/");
  if (specifier.startsWith("node:") || builtinModules.includes(first)) return `node:${first}`;
  return first.startsWith("@") ? `${first}/${second}` : first;
}

// Ways to load a package without an import, which this check reads. No file may use them.
// This check guards against drift, not against a determined author: a loader reached by a computed
// name, such as process["getBuiltinModule"], still gets past it.
const LOADERS = new Set(["createRequire", "getBuiltinModule"]);

type Parsed = ReturnType<typeof parseSync>;

function parse(file: SourceFile): Parsed {
  const parsed = parseSync(file.path, file.code);
  const [error] = parsed.errors;
  if (error !== undefined) throw new Error(`${file.path} could not be parsed: ${error.message}`);
  return parsed;
}

// The LOADERS that a parsed file names, such as in `m.createRequire(import.meta.url)("plaid")`.
function loadersIn(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const child of node) loadersIn(child, found);
  } else if (typeof node === "object" && node !== null) {
    const { type, name } = node as { type?: unknown; name?: unknown };
    if (type === "Identifier" && typeof name === "string" && LOADERS.has(name)) found.add(name);
    for (const child of Object.values(node)) loadersIn(child, found);
  }
  return found;
}

// A plain string, such as "plaid" or `plaid`, with no ${} in it.
const PLAIN_STRING = /^(["'`])[^"'`$]*\1$/;

// The files that may import node:module, with the reason.
const MAY_IMPORT_NODE_MODULE = new Map([
  ["src/seams.test.ts", "This check reads Node's list of built-in modules from it."],
]);

// The files that may hold an import() whose specifier is not a plain string, how many each may
// hold, and the reason. A file with more than its count has every such import() flagged.
const MAY_IMPORT_COMPUTED = new Map([
  [
    "src/jobs/sidequest.ts",
    {
      count: 1,
      reason: "Sidequest loads job classes from the job list's URL, so the jobs module imports it.",
    },
  ],
]);

// The import() calls in a file whose specifier is not a plain string, which this check cannot read.
function computedImports(file: SourceFile, { module }: Parsed): string[] {
  return module.dynamicImports
    .map(({ moduleRequest }) => file.code.slice(moduleRequest.start, moduleRequest.end))
    .filter((text) => !PLAIN_STRING.test(text));
}

// The import() calls in a file whose specifier is a plain string.
function dynamicSpecifiers(file: SourceFile, { module }: Parsed): string[] {
  return module.dynamicImports
    .map(({ moduleRequest }) => file.code.slice(moduleRequest.start, moduleRequest.end))
    .filter((text) => PLAIN_STRING.test(text))
    .map((text) => text.slice(1, -1));
}

function importedSpecifiers(file: SourceFile, parsed: Parsed): string[] {
  const { module } = parsed;
  return [
    ...module.staticImports.map((entry) => entry.moduleRequest.value),
    ...module.staticExports.flatMap((entry) =>
      entry.entries.flatMap((e) => (e.moduleRequest ? [e.moduleRequest.value] : [])),
    ),
    ...dynamicSpecifiers(file, parsed),
  ];
}

// The one AI call path (spec 08, What the AI provider gets). Every value from the `ai` package,
// such as generateText, is imported in src/ai/call.ts, which sends every request through the cost
// gate. providers.ts wraps each model with its AI provider's data-use setting. Test files and
// test support use the AI SDK's test models; a type passes anywhere in src/ai.
const AI_VALUE_IMPORTS: Record<string, readonly string[] | "all"> = {
  "src/ai/call.ts": "all",
  "src/ai/providers.ts": ["wrapLanguageModel"],
};

function isTestFile(path: string): boolean {
  return /\.test\.tsx?$/.test(path) || path.endsWith("/testing.ts");
}

// The names a file imports, or re-exports, from one specifier. "*" stands for a namespace or a
// default import. Types are left out.
function importedValues(file: SourceFile, matches: (specifier: string) => boolean): string[] {
  const parsed = parse(file);
  const { module } = parsed;
  const fromImports = module.staticImports
    .filter((entry) => matches(entry.moduleRequest.value))
    .flatMap((entry) =>
      entry.entries.filter((e) => !e.isType).map((e) => e.importName.name ?? "*"),
    );
  const fromExports = module.staticExports.flatMap((entry) =>
    entry.entries
      .filter((e) => e.moduleRequest !== null && matches(e.moduleRequest.value) && !e.isType)
      .map((e) => e.importName.name ?? "*"),
  );
  const dynamic = dynamicSpecifiers(file, parsed).some(matches) ? ["*"] : [];
  return [...fromImports, ...fromExports, ...dynamic];
}

function findCallPathBreaches(files: SourceFile[]): string[] {
  const breaches: string[] = [];
  for (const file of files) {
    if (isTestFile(file.path)) continue;
    const allowed = AI_VALUE_IMPORTS[file.path] ?? [];
    if (allowed === "all") continue;
    const values = importedValues(file, (specifier) => packageName(specifier) === "ai");
    for (const name of new Set(values)) {
      if (!allowed.includes(name)) {
        breaches.push(`${file.path} imports ${name} from ai, which only src/ai/call.ts may import`);
      }
    }
  }
  return breaches;
}

// Only src/ai/call.ts builds models, so every model is behind the cost gate: the AI
// provider packages' models are made in src/ai/providers.ts, and only call.ts takes a value from
// providers.ts. A raw model's doGenerate needs no import from ai, so this guards the models too.
const MODEL_BUILDERS: { owner: string; matches: (specifier: string, from: string) => boolean }[] = [
  {
    owner: "src/ai/providers.ts",
    matches: (specifier) => {
      const pkg = packageName(specifier);
      return pkg !== undefined && pkg !== "ai" && ownerOf(pkg) === "ai";
    },
  },
  {
    owner: "src/ai/call.ts",
    matches: (specifier, from) =>
      specifier.startsWith(".") &&
      posix.join(posix.dirname(from), specifier) === "src/ai/providers.ts",
  },
];

function findModelBuilderBreaches(files: SourceFile[]): string[] {
  const breaches: string[] = [];
  for (const file of files) {
    if (isTestFile(file.path)) continue;
    for (const { owner, matches } of MODEL_BUILDERS) {
      if (file.path === owner) continue;
      const values = importedValues(file, (specifier) => matches(specifier, file.path));
      for (const name of new Set(values)) {
        breaches.push(`${file.path} imports ${name}, which builds models only in ${owner}`);
      }
    }
  }
  return breaches;
}

// The db-level read of the Household facts returns them without their never-sent-to-AI mark, so
// the ai module reads them only through the household module.
const DB_FACTS = "src/db/household-facts.ts";
const DB_FACTS_NAMES = new Set(["readHouseholdFacts", "storeHouseholdFacts"]);

function findFactsBreaches(files: SourceFile[]): string[] {
  const breaches: string[] = [];
  for (const file of files.filter((f) => f.path.startsWith("src/ai/"))) {
    const target = (specifier: string) =>
      specifier.startsWith(".") ? posix.join(posix.dirname(file.path), specifier) : specifier;
    for (const entry of parse(file).module.staticImports) {
      const to = target(entry.moduleRequest.value);
      const names = entry.entries.map((e) => e.importName.name ?? "*");
      if (
        to === DB_FACTS ||
        (to.startsWith("src/db") && names.some((n) => DB_FACTS_NAMES.has(n)))
      ) {
        breaches.push(`${file.path} reads the Household facts from src/db`);
      }
    }
  }
  return breaches;
}

// Test support, such as src/db/testing.ts or src/ai/testing.ts, makes fake data, test keys, and
// test models, so it stays out of the app: only test files and other test support import it.
// A test entry point is test support that a test runs as its own program.
const TEST_ENTRY_POINTS = new Map([
  [
    "src/jobs/failing-job-probe.ts",
    "src/jobs/jobs.test.ts runs it with plain node, since Vitest hides what Sidequest writes to " +
      "stdout. No file imports it, so the build never reaches it.",
  ],
]);

// A test support folder holds only test support. The large-history check (`pnpm bench:history`)
// runs src/large-history/ under Vitest alone, so it may import test support and the app may not import it.
// A Vitest config, such as vitest.history.config.ts, is test tooling and may import it too.
const TEST_SUPPORT_DIRS = ["src/large-history/"];
const VITEST_CONFIG = /^vitest(?:\.[\w-]+)?\.config\.ts$/;

function isTestSupport(path: string): boolean {
  return (
    /(?:^|\/)testing\.tsx?$/.test(path) ||
    TEST_ENTRY_POINTS.has(path) ||
    TEST_SUPPORT_DIRS.some((dir) => path.startsWith(dir))
  );
}

function findTestSupportBreaches(files: SourceFile[]): string[] {
  const breaches: string[] = [];
  for (const file of files) {
    if (isTestFile(file.path) || isTestSupport(file.path) || VITEST_CONFIG.test(file.path))
      continue;
    for (const specifier of new Set(importedSpecifiers(file, parse(file)))) {
      if (!specifier.startsWith(".")) continue;
      const target = posix.join(posix.dirname(file.path), specifier);
      if (isTestSupport(target) || isTestSupport(`${target}.ts`)) {
        breaches.push(`${file.path} imports ${target}, which only tests may import`);
      }
    }
  }
  return breaches;
}

function moduleOf(path: string): string | undefined {
  const [top, module] = path.split("/");
  return top === "src" && module !== undefined && module in SEAMS ? module : undefined;
}

function findSeamBreaches(files: SourceFile[]): string[] {
  const breaches = new Set<string>();
  for (const file of files) {
    const parsed = parse(file);
    for (const loader of loadersIn(parsed.program)) {
      breaches.add(`${file.path} uses ${loader}, which loads packages past this check`);
    }
    const computed = computedImports(file, parsed);
    if (computed.length > (MAY_IMPORT_COMPUTED.get(file.path)?.count ?? 0)) {
      for (const specifier of computed) {
        breaches.add(`${file.path} imports ${specifier}, which this check cannot read`);
      }
    }
    for (const specifier of importedSpecifiers(file, parsed)) {
      if (packageName(specifier) === "node:module" && MAY_IMPORT_NODE_MODULE.has(file.path)) {
        continue;
      }
      if (importedByNone(specifier)) {
        breaches.add(`${file.path} imports ${specifier}, which no module may import`);
        continue;
      }
      const pkg = packageName(specifier);
      const owner = pkg === undefined ? undefined : ownerOf(pkg);
      if (owner !== undefined && owner !== moduleOf(file.path)) {
        breaches.add(`${file.path} imports ${specifier}, which only src/${owner} may import`);
      }
    }
  }
  return [...breaches];
}

function repoSourceFiles(dir = ROOT): SourceFile[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)
        ? []
        : repoSourceFiles(full);
    }
    if (!entry.isFile() || !SOURCE_FILE.test(entry.name)) return [];
    return [{ path: relative(ROOT, full).split(sep).join("/"), code: readFileSync(full, "utf8") }];
  });
}

describe("module seams", () => {
  it.each(Object.keys(SEAMS))("src/%s is a folder", (module) => {
    const dir = join(ROOT, "src", module);
    expect(existsSync(dir) && statSync(dir).isDirectory()).toBe(true);
  });

  it("flags a file outside a module that imports the module's package", () => {
    const files: SourceFile[] = [
      { path: "src/bank/plaid.ts", code: 'import { PlaidApi } from "plaid";' },
      { path: "src/web/pages/Home.tsx", code: 'import { PlaidApi } from "plaid";' },
      {
        path: "src/server/app.ts",
        code: 'import type { LibSQLDatabase } from "drizzle-orm/libsql";',
      },
      { path: "src/jobs/sync.ts", code: 'export { generateText } from "ai";' },
      { path: "src/auth/login.ts", code: 'const { randomBytes } = await import("crypto");' },
      { path: "src/secrets/keys.ts", code: 'import { createCipheriv } from "node:crypto";' },
      { path: "scripts/mail.ts", code: 'import nodemailer from "nodemailer";' },
    ];

    expect(findSeamBreaches(files)).toEqual([
      "src/web/pages/Home.tsx imports plaid, which only src/bank may import",
      "src/server/app.ts imports drizzle-orm/libsql, which only src/db may import",
      "src/jobs/sync.ts imports ai, which only src/ai may import",
      "src/auth/login.ts imports crypto, which only src/secrets may import",
      "scripts/mail.ts imports nodemailer, which only src/notify may import",
    ]);
  });

  it("gives every AI provider package to src/ai, but leaves @ai-sdk/react to the web app", () => {
    const files: SourceFile[] = [
      { path: "src/ai/models.ts", code: 'import { createGateway } from "@ai-sdk/gateway";' },
      { path: "src/server/chat.ts", code: 'import { createGateway } from "@ai-sdk/gateway";' },
      { path: "src/jobs/review.ts", code: 'import { createAnthropic } from "@ai-sdk/anthropic";' },
      {
        path: "src/web/chat.tsx",
        code: 'import { createOpenRouter } from "@openrouter/ai-sdk-provider";',
      },
      { path: "src/web/pages/Chat.tsx", code: 'import { useChat } from "@ai-sdk/react";' },
    ];

    expect(findSeamBreaches(files)).toEqual([
      "src/server/chat.ts imports @ai-sdk/gateway, which only src/ai may import",
      "src/jobs/review.ts imports @ai-sdk/anthropic, which only src/ai may import",
      "src/web/chat.tsx imports @openrouter/ai-sdk-provider, which only src/ai may import",
    ]);
  });

  it("allows Sidequest only in src/jobs", () => {
    const files: SourceFile[] = [
      { path: "src/jobs/sidequest.ts", code: 'import { Sidequest } from "sidequest";' },
      { path: "src/jobs/engine.ts", code: 'import { Engine } from "@sidequest/engine";' },
      { path: "src/server/start.ts", code: 'import { Sidequest } from "sidequest";' },
      { path: "src/bank/sync.ts", code: 'import { Job } from "@sidequest/core";' },
    ];

    expect(findSeamBreaches(files)).toEqual([
      "src/server/start.ts imports sidequest, which only src/jobs may import",
      "src/bank/sync.ts imports @sidequest/core, which only src/jobs may import",
    ]);
  });

  it("flags createRequire and getBuiltinModule, which load packages without an import", () => {
    const files: SourceFile[] = [
      {
        path: "src/server/plaid.ts",
        code: [
          'import { createRequire } from "node:module";',
          'const { PlaidApi } = createRequire(import.meta.url)("plaid");',
        ].join("\n"),
      },
      {
        path: "src/jobs/load.ts",
        code: 'const mod = await import("node:module");\nmod.createRequire(import.meta.url);',
      },
      {
        path: "src/auth/keys.ts",
        code: 'const { randomBytes } = process.getBuiltinModule("node:crypto");',
      },
      {
        path: "src/db/note.ts",
        code: '// createRequire is not used here.\nconst s = "createRequire";',
      },
    ];

    expect(findSeamBreaches(files)).toEqual([
      "src/server/plaid.ts uses createRequire, which loads packages past this check",
      "src/server/plaid.ts imports node:module, which no module may import",
      "src/jobs/load.ts uses createRequire, which loads packages past this check",
      "src/jobs/load.ts imports node:module, which no module may import",
      "src/auth/keys.ts uses getBuiltinModule, which loads packages past this check",
    ]);
  });

  it("flags node:module in any file but this check, which reads Node's built-in modules", () => {
    const files: SourceFile[] = [
      { path: "src/seams.test.ts", code: 'import { builtinModules } from "node:module";' },
      { path: "src/db/builtins.ts", code: 'import { builtinModules } from "module";' },
      {
        path: "scripts/load.ts",
        code: [
          'import * as m from "node:module";',
          'm["createRequire"](import.meta.url)("plaid");',
        ].join("\n"),
      },
    ];

    expect(findSeamBreaches(files)).toEqual([
      "src/db/builtins.ts imports module, which no module may import",
      "scripts/load.ts imports node:module, which no module may import",
    ]);
  });

  it("flags an import() it cannot read, but for the job list's one in src/jobs/sidequest.ts", () => {
    const files: SourceFile[] = [
      { path: "src/jobs/sidequest.ts", code: "const list = await import(url);" },
      { path: "src/jobs/load.ts", code: "const list = await import(url);" },
      { path: "src/server/bank.ts", code: 'const name = "plaid";\nawait import(name);' },
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this code uses ${}.
      { path: "src/ai/model.ts", code: "await import(`@ai-sdk/${provider}`);" },
      { path: "src/web/main.tsx", code: 'await import("pla" + "id");' },
      { path: "src/db/client.ts", code: "await import(`@libsql/client`);" },
    ];

    expect(findSeamBreaches(files)).toEqual([
      "src/jobs/load.ts imports url, which this check cannot read",
      "src/server/bank.ts imports name, which this check cannot read",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this code uses ${}.
      "src/ai/model.ts imports `@ai-sdk/${provider}`, which this check cannot read",
      'src/web/main.tsx imports "pla" + "id", which this check cannot read',
    ]);
  });

  it("flags every import() it cannot read in src/jobs/sidequest.ts once it holds a second", () => {
    const files: SourceFile[] = [
      {
        path: "src/jobs/sidequest.ts",
        code: "const list = await import(url);\nconst plaid = await import(name);",
      },
    ];

    expect(findSeamBreaches(files)).toEqual([
      "src/jobs/sidequest.ts imports url, which this check cannot read",
      "src/jobs/sidequest.ts imports name, which this check cannot read",
    ]);
  });

  it("flags a synchronous SQLite driver in any file, src/db included", () => {
    const files: SourceFile[] = [
      { path: "src/db/client.ts", code: 'import { createClient } from "@libsql/client";' },
      { path: "src/db/fast.ts", code: 'import Database from "libsql";' },
      { path: "src/jobs/queue.ts", code: 'import Database from "better-sqlite3";' },
      { path: "src/db/check.ts", code: 'const { DatabaseSync } = await import("node:sqlite");' },
    ];

    expect(findSeamBreaches(files)).toEqual([
      "src/db/fast.ts imports libsql, which no module may import",
      "src/jobs/queue.ts imports better-sqlite3, which no module may import",
      "src/db/check.ts imports node:sqlite, which no module may import",
    ]);
  });

  it("flags Drizzle's other drivers in any file, and allows its libSQL driver", () => {
    const files: SourceFile[] = [
      {
        path: "src/db/client.ts",
        code: [
          'import { drizzle } from "drizzle-orm/libsql";',
          'import { migrate } from "drizzle-orm/libsql/migrator";',
          'import { sqliteTable } from "drizzle-orm/sqlite-core";',
        ].join("\n"),
      },
      { path: "src/db/fast.ts", code: 'import { drizzle } from "drizzle-orm/better-sqlite3";' },
      { path: "src/db/bun.ts", code: 'import { migrate } from "drizzle-orm/bun-sqlite/migrator";' },
      { path: "src/db/wasm.ts", code: 'const { drizzle } = await import("drizzle-orm/sql-js");' },
      { path: "src/jobs/proxy.ts", code: 'export { drizzle } from "drizzle-orm/sqlite-proxy";' },
    ];

    expect(findSeamBreaches(files)).toEqual([
      "src/db/fast.ts imports drizzle-orm/better-sqlite3, which no module may import",
      "src/db/bun.ts imports drizzle-orm/bun-sqlite/migrator, which no module may import",
      "src/db/wasm.ts imports drizzle-orm/sql-js, which no module may import",
      "src/jobs/proxy.ts imports drizzle-orm/sqlite-proxy, which no module may import",
    ]);
  });

  it("finds every Drizzle SQLite driver other than libSQL", () => {
    expect([...OTHER_DRIZZLE_DRIVERS]).toEqual(
      expect.arrayContaining([
        "better-sqlite3",
        "bun-sqlite",
        "d1",
        "durable-sqlite",
        "expo-sqlite",
        "op-sqlite",
        "sql-js",
        "sqlite-proxy",
      ]),
    );
    expect(OTHER_DRIZZLE_DRIVERS.has("libsql")).toBe(false);
  });

  it("flags a value from ai imported anywhere but the one AI call path", () => {
    const files: SourceFile[] = [
      { path: "src/ai/call.ts", code: 'import { generateText, wrapLanguageModel } from "ai";' },
      { path: "src/ai/providers.ts", code: 'import { wrapLanguageModel } from "ai";' },
      {
        path: "src/ai/settings.ts",
        code: 'import { generateText, type LanguageModel } from "ai";',
      },
      { path: "src/ai/summary.ts", code: 'import type { ModelMessage } from "ai";' },
      { path: "src/ai/chat.ts", code: 'import * as sdk from "ai";' },
      { path: "src/ai/tools.ts", code: 'export { streamText } from "ai";' },
      { path: "src/ai/agent.ts", code: 'const { streamText } = await import("ai");' },
      { path: "src/ai/testing.ts", code: 'import { MockLanguageModelV4 } from "ai/test";' },
      { path: "src/ai/chat.test.ts", code: 'import { generateText } from "ai";' },
    ];

    expect(findCallPathBreaches(files)).toEqual([
      "src/ai/settings.ts imports generateText from ai, which only src/ai/call.ts may import",
      "src/ai/chat.ts imports * from ai, which only src/ai/call.ts may import",
      "src/ai/tools.ts imports streamText from ai, which only src/ai/call.ts may import",
      "src/ai/agent.ts imports * from ai, which only src/ai/call.ts may import",
    ]);
  });

  it("flags a model built anywhere but the one AI call path", () => {
    const files: SourceFile[] = [
      { path: "src/ai/providers.ts", code: 'import { createAnthropic } from "@ai-sdk/anthropic";' },
      { path: "src/ai/call.ts", code: 'import { makeFetchModels } from "./providers.ts";' },
      {
        path: "src/ai/settings.ts",
        code: 'import { type AiModelMaker, makeFetchModels } from "./providers.ts";',
      },
      { path: "src/ai/index.ts", code: 'export { makeFetchModels } from "./providers.ts";' },
      { path: "src/ai/summary.ts", code: 'import type { AiModels } from "./providers.ts";' },
      { path: "src/ai/chat.ts", code: 'import { createOpenAI } from "@ai-sdk/openai";' },
      { path: "src/server/ai.ts", code: 'import { makeFetchModels } from "../ai/providers.ts";' },
      { path: "src/web/Chat.tsx", code: 'import { useChat } from "@ai-sdk/react";' },
      { path: "src/ai/testing.ts", code: 'import { makeFetchModels } from "./providers.ts";' },
    ];

    expect(findModelBuilderBreaches(files)).toEqual([
      "src/ai/settings.ts imports makeFetchModels, which builds models only in src/ai/call.ts",
      "src/ai/index.ts imports makeFetchModels, which builds models only in src/ai/call.ts",
      "src/ai/chat.ts imports createOpenAI, which builds models only in src/ai/providers.ts",
      "src/server/ai.ts imports makeFetchModels, which builds models only in src/ai/call.ts",
    ]);
  });

  it("flags the ai module reading the Household facts from src/db", () => {
    const files: SourceFile[] = [
      {
        path: "src/ai/call.ts",
        code: 'import { readHouseholdFacts } from "../household/index.ts";',
      },
      { path: "src/ai/a.ts", code: 'import { readHouseholdFacts } from "../db/index.ts";' },
      { path: "src/ai/b.ts", code: 'import { readHouseholdFacts as read } from "../db/index.ts";' },
      {
        path: "src/ai/c.ts",
        code: 'import type { StoredHouseholdFacts } from "../db/household-facts.ts";',
      },
      { path: "src/ai/d.ts", code: 'import { listAccounts } from "../db/index.ts";' },
      {
        path: "src/household/facts.ts",
        code: 'import { readHouseholdFacts } from "../db/index.ts";',
      },
    ];

    expect(findFactsBreaches(files)).toEqual([
      "src/ai/a.ts reads the Household facts from src/db",
      "src/ai/b.ts reads the Household facts from src/db",
      "src/ai/c.ts reads the Household facts from src/db",
    ]);
  });

  it("flags test support imported by a file that is not a test", () => {
    const files: SourceFile[] = [
      { path: "src/ai/call.ts", code: 'import { StubModels } from "./testing.ts";' },
      { path: "src/server/start.ts", code: 'export { newTestDatabase } from "../db/testing.ts";' },
      { path: "src/bank/sync.ts", code: 'const t = await import("./testing");' },
      { path: "src/jobs/run.ts", code: 'import "./failing-job-probe.ts";' },
      { path: "src/db/testing.ts", code: 'import { newAiKey } from "../ai/testing.ts";' },
      { path: "src/ai/call.test.ts", code: 'import { StubModels } from "./testing.ts";' },
      { path: "src/jobs/failing-job-probe.ts", code: 'import { failWith } from "./testing.ts";' },
      { path: "src/ai/settings.ts", code: 'import { privateModels } from "./call.ts";' },
    ];

    expect(findTestSupportBreaches(files)).toEqual([
      "src/ai/call.ts imports src/ai/testing.ts, which only tests may import",
      "src/server/start.ts imports src/db/testing.ts, which only tests may import",
      "src/bank/sync.ts imports src/bank/testing, which only tests may import",
      "src/jobs/run.ts imports src/jobs/failing-job-probe.ts, which only tests may import",
    ]);
  });

  it("no file but a test imports test support", () => {
    expect(findTestSupportBreaches(repoSourceFiles())).toEqual([]);
  });

  it("no file outside a module imports a package the seams table gives to that module", () => {
    const files = repoSourceFiles();

    expect(files.length).toBeGreaterThan(0);
    expect(findSeamBreaches(files)).toEqual([]);
  });

  it("every AI call goes through src/ai/call.ts, and the ai module reads no facts from src/db", () => {
    const files = repoSourceFiles();

    expect(findCallPathBreaches(files)).toEqual([]);
    expect(findModelBuilderBreaches(files)).toEqual([]);
    expect(findFactsBreaches(files)).toEqual([]);
  });
});
