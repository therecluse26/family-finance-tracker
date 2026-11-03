import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "vite";
import { describe, expect, it } from "vitest";

// The "Module seams" table in docs/spec/10-stack-and-architecture.md.
// Each module under src/ is the sole importer of its packages. "@scope/*" means every package
// in that scope, so `ai` owns every AI provider package, such as @ai-sdk/gateway.
const SEAMS: Record<string, readonly string[]> = {
  db: ["drizzle-orm", "@libsql/client"],
  jobs: ["sidequest"],
  bank: ["plaid"],
  ai: ["ai", "@ai-sdk/*", "@openrouter/*"],
  secrets: ["node:crypto"],
  notify: ["web-push", "nodemailer"],
  auth: ["better-auth", "@better-auth/passkey"],
};

// The Chat page's answer stream in the browser. It is not an AI provider package.
const OWNED_BY_NONE = new Set(["@ai-sdk/react"]);

function ownerOf(pkg: string): string | undefined {
  if (OWNED_BY_NONE.has(pkg)) return undefined;
  const owns = (pattern: string) =>
    pattern.endsWith("/*") ? pkg.startsWith(pattern.slice(0, -1)) : pkg === pattern;
  return Object.keys(SEAMS).find((module) => SEAMS[module]?.some(owns));
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIPPED_DIRS = new Set(["node_modules", "dist", "coverage"]);
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

type SourceFile = { path: string; code: string };

function packageName(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
  const bare = specifier.replace(/^node:/, "");
  const [first = "", second = ""] = bare.split("/");
  if (specifier.startsWith("node:") || builtinModules.includes(first)) return `node:${first}`;
  return first.startsWith("@") ? `${first}/${second}` : first;
}

function importedSpecifiers(file: SourceFile): string[] {
  const { module, errors } = parseSync(file.path, file.code);
  if (errors.length > 0) throw new Error(`${file.path} could not be parsed: ${errors[0]?.message}`);
  const dynamic = module.dynamicImports
    .map(({ moduleRequest }) => file.code.slice(moduleRequest.start, moduleRequest.end))
    .filter((text) => /^(["'`])[^"'`$]*\1$/.test(text))
    .map((text) => text.slice(1, -1));
  return [
    ...module.staticImports.map((entry) => entry.moduleRequest.value),
    ...module.staticExports.flatMap((entry) =>
      entry.entries.flatMap((e) => (e.moduleRequest ? [e.moduleRequest.value] : [])),
    ),
    ...dynamic,
  ];
}

function moduleOf(path: string): string | undefined {
  const [top, module] = path.split("/");
  return top === "src" && module !== undefined && module in SEAMS ? module : undefined;
}

function findSeamBreaches(files: SourceFile[]): string[] {
  const breaches = new Set<string>();
  for (const file of files) {
    for (const specifier of importedSpecifiers(file)) {
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

  it("no file outside a module imports a package the seams table gives to that module", () => {
    const files = repoSourceFiles();

    expect(files.length).toBeGreaterThan(0);
    expect(findSeamBreaches(files)).toEqual([]);
  });
});
