import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { closeDatabase, openDatabase } from "./client.ts";
import { readSettings, rebuildMigrations } from "./testing.ts";

// The rule in "Database files", docs/spec/10-stack-and-architecture.md. This file is searched like
// any other, so it never writes the word whole: it builds it from two halves.
const WORD = ["PRAG", "MA"].join("");

// Every use of the word counts, in any case, in comments and strings too. Nothing is parsed or
// stripped first. The one exception is the word with a letter, digit, or _ right after it, as in
// pragma_integrity_check(). SQLite has those table-valued functions only for settings it can read
// without side effects, so they cannot change one. A test below checks this.
const USE = new RegExp(`${WORD}(?!\\w)`, "gi");

// A line that uses the word must be exactly one of these, apart from the whitespace at its ends.
const DRIVER_SETUP = "src/db/client.ts";
const WAL = `await client.execute("${WORD} journal_mode = WAL");`;
const MIGRATION_FILE = /^drizzle\/[^/]+\.sql$/;
const PAIR_OFF = `${WORD} foreign_keys=OFF;`;
const PAIR_ON = `${WORD} foreign_keys=ON;`;
const BREAKPOINT = "--> statement-breakpoint";

// The driver setup applies WAL mode when it opens app.db. The driver applies the busy timeout
// itself. A generated migration may hold drizzle-kit's pair around a table rebuild, as drizzle-kit
// writes it: OFF, then ON. The pair sets nothing, because the driver's migrate() already turns
// foreign keys off outside the migration's transaction, and SQLite ignores the pair inside one.
function allowedLines(path: string): string[] {
  if (path === DRIVER_SETUP) return [WAL];
  if (MIGRATION_FILE.test(path)) {
    return [PAIR_OFF, PAIR_ON].flatMap((line) => [line, `${line}${BREAKPOINT}`]);
  }
  return [];
}

const RULE = [
  `Each use of the word ${WORD}, in any case, in comments and strings too, must be on a line that`,
  "is exactly one of these:",
  `- in ${DRIVER_SETUP}: ${WAL}`,
  `- in drizzle/*.sql, drizzle-kit's pair, OFF then ON: ${PAIR_OFF} and ${PAIR_ON}`,
  `  each alone on its line or followed by ${BREAKPOINT}`,
  "To read a setting, use its table-valued function, such as",
  'SELECT * FROM pragma_integrity_check(). See "Database files" in',
  "docs/spec/10-stack-and-architecture.md.",
].join("\n");

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
// The search reads every file, through symbolic links, except the spec's prose and the folders
// .gitignore leaves out. Vite can import any file as text, so a .md file in src/ is read too.
const SKIPPED_DIRS = new Set([
  ".claude",
  ".git",
  ".playwright-mcp",
  "coverage",
  "dist",
  "node_modules",
]);
const PROSE = /^(?:docs\/.+|[^/]+)\.md$/;

type RepoFile = { path: string; code: string };

function flaggedLines({ path, code }: RepoFile): string[] {
  const allowed = allowedLines(path);
  const flagged: number[] = [];
  let openOff: number | undefined;
  code.split("\n").forEach((line, i) => {
    if (!line.match(USE)) return;
    const form = line.trim();
    if (!allowed.includes(form)) {
      flagged.push(i + 1);
    } else if (form.startsWith(PAIR_OFF)) {
      if (openOff === undefined) openOff = i + 1;
      else flagged.push(i + 1);
    } else if (form.startsWith(PAIR_ON)) {
      if (openOff !== undefined) openOff = undefined;
      else flagged.push(i + 1);
    }
  });
  if (openOff !== undefined) flagged.push(openOff);
  return flagged.sort((a, b) => a - b).map((line) => `${path}:${line}`);
}

function flagged(files: RepoFile[]): string[] {
  return files.flatMap(flaggedLines);
}

function repoFiles(root = ROOT): RepoFile[] {
  const seen = new Set<string>();
  const walk = (dir: string): RepoFile[] => {
    const real = realpathSync(dir);
    if (seen.has(real)) return [];
    seen.add(real);
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      const stat = statSync(full, { throwIfNoEntry: false });
      const path = relative(root, full).split(sep).join("/");
      if (stat?.isDirectory()) return SKIPPED_DIRS.has(name) ? [] : walk(full);
      if (!stat?.isFile() || PROSE.test(path)) return [];
      return [{ path, code: readFileSync(full, "utf8") }];
    });
  };
  return walk(root);
}

const flagsIn = (path: string, code: string) => flagged([{ path, code }]);

const MIGRATION_PAIR = [
  `${PAIR_OFF}${BREAKPOINT}`,
  "CREATE TABLE `__new_parent` (`id` integer PRIMARY KEY NOT NULL);",
  BREAKPOINT,
  PAIR_ON,
].join("\n");

const CODE_THAT_PASSES = [
  "const rows = await database.all(sql`SELECT * FROM pragma_integrity_check()`);",
  'const result = await copy.execute("SELECT * FROM pragma_integrity_check()");',
  "const mode = await database.get(sql`SELECT journal_mode FROM pragma_journal_mode()`);",
];

// The word is joined in at run time below, so these lines hold it whole, as code would.
const CODE_THAT_IS_FLAGGED: [string, string][] = [
  ["a read", "const rows = await database.all(sql`WORD integrity_check`);"],
  ["a read through the client", 'const result = await copy.execute("WORD integrity_check");'],
  ["a setting", "await database.run(sql`WORD synchronous = OFF`);"],
  ["the driver setup's line", WAL],
  ["drizzle-kit's pair", 'await client.execute("WORD foreign_keys=OFF;");'],
  ["lower case", 'await client.execute("word synchronous=OFF");'],
  ["mixed case", 'await client.execute("WoRd synchronous=OFF");'],
  ["a comment", "// WORD synchronous=OFF would speed this up."],
  ["a \\n escape right before it", 'await client.execute("SELECT 1;\\nWORD synchronous=OFF");'],
  ["a letter right before it", 'await client.execute("xWORD synchronous=OFF");'],
  ["a -- earlier on the line", 'i--; await client.execute("WORD synchronous=OFF");'],
  [
    "round 3's first probe: // inside a string, then +",
    `await database.$client.executeMultiple("SELECT '//'; WORD synchronous=OFF;" + "SELECT 1;");`,
  ],
  // biome-ignore-start lint/suspicious/noTemplateCurlyInString: this code uses ${}.
  [
    "round 3's second probe: a // .get( comment before a literal in sql.raw()",
    [
      "await database.run(",
      "  sql`${sql.raw(",
      "    // .get(",
      '    "WORD journal_mode",',
      "  )}=DELETE`,",
      ");",
    ].join("\n"),
  ],
  // biome-ignore-end lint/suspicious/noTemplateCurlyInString: this code uses ${}.
];

const DRIVER_SETUP_THAT_IS_FLAGGED: [string, string][] = [
  ["another setting", `${WAL}\nawait client.execute("WORD synchronous = OFF");`],
  ["a second statement on the line", WAL.replace("WAL", "WAL; WORD synchronous = OFF")],
  ["WAL mode spaced another way", WAL.replace(" = ", "=")],
  ["WAL mode in a comment", `// ${WAL}`],
  ["a comment that names the word", "// The only code that sets a WORD."],
];

const MIGRATIONS_THAT_ARE_FLAGGED: [string, string][] = [
  ["a bare read of integrity_check", "WORD integrity_check;"],
  ["a bare read of foreign_keys", "WORD foreign_keys;"],
  ["a block comment before =", "WORD journal_mode/**/=DELETE;"],
  ["a line comment before =", "WORD journal_mode -- x\n=DELETE;"],
  ["another setting", "WORD synchronous=OFF;"],
  ["a setting in mixed case", "WoRd journal_mode=DELETE;"],
  ["spaces around =", "WORD foreign_keys = OFF;\nWORD foreign_keys = ON;"],
  ["the pair in lower case", "word foreign_keys=off;\nword foreign_keys=on;"],
  ["the pair in mixed case", "WORD Foreign_Keys=OFF;\nWORD Foreign_Keys=ON;"],
  ["a tab in the pair", "WORD\tforeign_keys=OFF;\nWORD foreign_keys=ON;"],
  ["a comment after the pair", "WORD foreign_keys=OFF; -- x\nWORD foreign_keys=ON;"],
  [
    "a setting glued to the pair",
    "WORD foreign_keys=OFF;WORD synchronous=OFF;\nWORD foreign_keys=ON;",
  ],
  ["a commented-out OFF before a real ON", "-- WORD foreign_keys=OFF;\nWORD foreign_keys=ON;"],
  ["OFF without ON", "WORD foreign_keys=OFF;"],
  ["ON without OFF", "WORD foreign_keys=ON;"],
  ["ON before OFF", "WORD foreign_keys=ON;\nWORD foreign_keys=OFF;"],
  ["OFF twice", "WORD foreign_keys=OFF;\nWORD foreign_keys=OFF;\nWORD foreign_keys=ON;"],
  ["a comment", "-- WORD synchronous=OFF;\nCREATE TABLE `t` (`id` integer);"],
  ["another setting inside the pair", MIGRATION_PAIR.replace("CREATE", "WORD a=1; CREATE")],
];

// Puts the word in place of WORD, in lower case for word, and in mixed case for WoRd.
const withWord = (text: string) =>
  text
    .replaceAll("WORD", WORD)
    .replaceAll("word", WORD.toLowerCase())
    .replaceAll("WoRd", ["PrAg", "Ma"].join(""));

describe(`${WORD} statements`, () => {
  it.each(CODE_THAT_PASSES)("passes a table-valued function: %s", (code) => {
    expect(flagsIn("src/db/backup.ts", code)).toEqual([]);
  });

  it.each(CODE_THAT_IS_FLAGGED)("flags %s in code", (_kind, code) => {
    expect(flagsIn("src/db/backup.ts", withWord(code))).not.toEqual([]);
  });

  it("passes the driver setup's line in the driver setup", () => {
    expect(flagsIn(DRIVER_SETUP, `  try {\n    ${WAL}\n  }`)).toEqual([]);
  });

  it.each(DRIVER_SETUP_THAT_IS_FLAGGED)("flags %s in the driver setup", (_kind, code) => {
    expect(flagsIn(DRIVER_SETUP, withWord(code))).not.toEqual([]);
  });

  it("passes drizzle-kit's pair in a migration, exactly as it writes it", () => {
    const path = "drizzle/0003_rebuild.sql";

    expect(flagsIn(path, MIGRATION_PAIR)).toEqual([]);
    expect(flagsIn(path, `${MIGRATION_PAIR}${BREAKPOINT}\n${MIGRATION_PAIR}`)).toEqual([]);
    expect(flagsIn(path, `${PAIR_OFF}\nDROP TABLE \`t\`;\n${PAIR_ON}`)).toEqual([]);
  });

  it.each(MIGRATIONS_THAT_ARE_FLAGGED)("flags %s in a migration", (_kind, code) => {
    expect(flagsIn("drizzle/0003_rebuild.sql", withWord(code))).not.toEqual([]);
  });

  it("flags drizzle-kit's pair outside drizzle/*.sql", () => {
    expect(flagsIn("drizzle/meta/0003_rebuild.sql", MIGRATION_PAIR)).toEqual([
      "drizzle/meta/0003_rebuild.sql:1",
      "drizzle/meta/0003_rebuild.sql:4",
    ]);
    expect(flagsIn("src/db/rebuild.sql", MIGRATION_PAIR)).toHaveLength(2);
  });

  it("names the line of each use it flags", () => {
    expect(flagsIn("src/x.ts", withWord("const a = 1;\n\ndb.run(sql`WORD a=1`); // WORD"))).toEqual(
      ["src/x.ts:3"],
    );
  });

  it("passes drizzle-kit's own table rebuild in drizzle/, and flags anything added to it", async () => {
    const [, rebuild] = await rebuildMigrations();
    const path = `drizzle/${rebuild.tag}.sql`;
    const lines = rebuild.sql.split("\n").length;
    const added = [
      "WORD integrity_check;",
      "WORD foreign_keys;",
      "WORD journal_mode/**/=DELETE;",
      "WORD synchronous=OFF;",
    ].map(withWord);

    expect(rebuild.sql.startsWith(`${PAIR_OFF}${BREAKPOINT}\n`)).toBe(true);
    expect(rebuild.sql.endsWith(`\n${PAIR_ON}`)).toBe(true);
    expect(flagsIn(path, rebuild.sql)).toEqual([]);
    expect(flagsIn(path, [rebuild.sql, ...added].join("\n"))).toEqual(
      added.map((_line, i) => `${path}:${lines + 1 + i}`),
    );
  });

  it("a table-valued function reads a setting but cannot change it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fft-settings-"));
    const database = await openDatabase(`file:${join(dir, "app.db")}`);
    try {
      const before = await readSettings(database);
      for (const name of ["journal_mode", "foreign_keys", "synchronous", "busy_timeout"]) {
        for (const value of ["0", "'delete'", "'off'", "'main'"]) {
          await database.$client
            .execute(`SELECT * FROM pragma_${name}(${value})`)
            .catch(() => undefined);
        }
      }

      expect(before.journal_mode).toBe("wal");
      expect(await readSettings(database)).toEqual(before);
    } finally {
      closeDatabase(database);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads every file through symbolic links, except prose and ignored folders", () => {
    const dir = mkdtempSync(join(tmpdir(), "fft-search-"));
    try {
      const setting = withWord("await client.execute('WORD synchronous=OFF');");
      for (const folder of ["outside", "repo/src/db", "repo/docs", "repo/node_modules/x"]) {
        mkdirSync(join(dir, folder), { recursive: true });
      }
      for (const file of [
        "outside/a.ts",
        "repo/src/db/query.md",
        "repo/docs/notes.md",
        "repo/README.md",
        "repo/node_modules/x/index.js",
      ]) {
        writeFileSync(join(dir, file), setting);
      }
      symlinkSync(join(dir, "outside/a.ts"), join(dir, "repo/src/db/linked.ts"));
      symlinkSync(join(dir, "outside"), join(dir, "repo/src/linked"));
      symlinkSync(join(dir, "repo"), join(dir, "repo/src/loop"));

      expect(flagged(repoFiles(join(dir, "repo"))).sort()).toEqual([
        "src/db/linked.ts:1",
        "src/db/query.md:1",
        "src/linked/a.ts:1",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const paths = repoFiles().map((file) => file.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        DRIVER_SETUP,
        relative(ROOT, fileURLToPath(import.meta.url))
          .split(sep)
          .join("/"),
        "Dockerfile",
        "package.json",
        "drizzle/meta/_journal.json",
      ]),
    );
  });

  it("the driver setup applies WAL mode", () => {
    const lines = readFileSync(join(ROOT, DRIVER_SETUP), "utf8").split("\n");

    expect(lines.map((line) => line.trim())).toContain(WAL);
  });

  it("no file uses the word except on an allowed line", () => {
    expect(flagged(repoFiles()), RULE).toEqual([]);
  });
});
