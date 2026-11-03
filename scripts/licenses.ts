import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, parseRecords } from "./records.ts";

// "The license check" in docs/spec/10-stack-and-architecture.md.
export const SHIPPED_LICENSES = [
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
  "MPL-2.0",
  "LGPL-2.1",
  "LGPL-3.0",
  "GPL-3.0",
  "AGPL-3.0",
] as const;

export const BUILD_TIME_LICENSES = [...SHIPPED_LICENSES, "CC-BY-4.0"] as const;

// SPDX exceptions that only add permissions, so "X WITH exception" stays as compatible as X.
export const LICENSE_EXCEPTIONS = [
  "LLVM-exception",
  "Classpath-exception-2.0",
  "GCC-exception-3.1",
  "Autoconf-exception-3.0",
  "Bison-exception-2.2",
] as const;

// Build tools whose helper code enters the browser bundle. They stay in devDependencies, but
// the license check treats them as shipped code, and the browser notices list them.
export const BUNDLER_PACKAGES: readonly string[] = ["vite", "rolldown"];

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const REVIEWED_FILE = "licenses/reviewed.json";

export type InstalledPackage = {
  name: string;
  version: string;
  path: string;
  // The license field of the package's own package.json. pnpm's value is not used: it is a
  // guess from the LICENSE file when the field is missing or says "SEE LICENSE IN".
  declared: string | undefined;
};

export type ReviewedRecord = Record<
  "package" | "version" | "license" | "reviewer" | "date",
  string
> & {
  // For a package that ships no license file: a file in licenses/texts/ with its license text.
  licenseText?: string;
};

const LICENSE_TEXT_FILE = /^licenses\/texts\/[\w@.+-]+\.txt$/;

export function parseReviewed(json: unknown): ReviewedRecord[] {
  const records: ReviewedRecord[] = parseRecords(
    json,
    REVIEWED_FILE,
    ["package", "version", "license", "reviewer", "date"],
    ["date"],
  );
  return records.map((record, index) => {
    const source = (json as unknown[])[index] as Record<string, unknown>;
    if (source.licenseText === undefined) return record;
    if (typeof source.licenseText !== "string" || !LICENSE_TEXT_FILE.test(source.licenseText)) {
      throw new Error(
        `Record ${index + 1} in ${REVIEWED_FILE} needs "licenseText" as a .txt file in licenses/texts/.`,
      );
    }
    return { ...record, licenseText: source.licenseText };
  });
}

export function readReviewed(root = ROOT): ReviewedRecord[] {
  return parseReviewed(JSON.parse(readFileSync(join(root, REVIEWED_FILE), "utf8")));
}

// The license field as written. The old "licenses" list offered a choice, so it joins with OR.
export function declaredLicense(manifest: unknown): string | undefined {
  if (!isRecord(manifest)) return undefined;
  const typeOf = (value: unknown) => {
    const type = isRecord(value) ? value.type : value;
    return typeof type === "string" && type.trim() !== "" ? type.trim() : undefined;
  };
  if (manifest.license !== undefined) return typeOf(manifest.license);
  const { licenses } = manifest;
  if (!Array.isArray(licenses) || licenses.length === 0) return undefined;
  const types = licenses.map(typeOf);
  return types.every((type) => type !== undefined) ? types.join(" OR ") : undefined;
}

// These fields name no license the rules can judge, so a person reads the package's files.
export function needsReview(declared: string | undefined): boolean {
  return (
    declared === undefined ||
    /^see licen[cs]e in\b/i.test(declared) ||
    declared.toUpperCase() === "UNLICENSED"
  );
}

function readManifest(dir: string): unknown {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

// Reads the output of `pnpm licenses list --json`, which groups packages by license.
export function parsePnpmLicenses(
  json: unknown,
  manifestAt: (dir: string) => unknown = readManifest,
): InstalledPackage[] {
  const unexpected = (detail: string) =>
    new Error(`pnpm licenses list --json gave an unexpected shape: ${detail}.`);
  if (!isRecord(json)) throw unexpected("not an object");
  return Object.values(json).flatMap((group) => {
    if (!Array.isArray(group)) throw unexpected("a license group is not a list");
    return group.flatMap((entry: unknown) => {
      if (!isRecord(entry)) throw unexpected("an entry is not an object");
      const { name, versions, paths } = entry;
      if (
        typeof name !== "string" ||
        !isStringList(versions) ||
        !isStringList(paths) ||
        versions.length === 0 ||
        versions.length !== paths.length
      ) {
        throw unexpected(`the entry for ${String(name)}`);
      }
      return versions.map((version, i) => {
        const path = paths[i] as string;
        return { name, version, path, declared: declaredLicense(manifestAt(path)) };
      });
    });
  });
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export type Tree = "prod" | "dev" | "all";

export function listInstalled(tree: Tree, root = ROOT): InstalledPackage[] {
  const flag = { prod: ["--prod"], dev: ["--dev"], all: [] }[tree];
  const out = execFileSync("pnpm", ["licenses", "list", "--json", ...flag], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return parsePnpmLicenses(JSON.parse(out));
}

const OPERATORS = new Set(["AND", "OR", "WITH"]);

function isListed(id: string, list: readonly string[]): boolean {
  const base = id.replace(/(?:\+|-only|-or-later)$/i, "").toLowerCase();
  return list.some((listed) => listed.toLowerCase() === base);
}

// Evaluates an SPDX expression. OR needs one allowed option and AND needs all of them.
// "X WITH exception" passes when X does and the exception is on LICENSE_EXCEPTIONS.
// Anything that does not parse, such as "SEE LICENSE IN LICENSE", is not allowed.
export function isAllowed(expression: string, allowlist: readonly string[]): boolean {
  const tokens = expression.replace(/[()]/g, " $& ").trim().split(/\s+/);
  let at = 0;
  const peek = () => tokens[at]?.toUpperCase();
  const isId = (token: string | undefined): token is string =>
    token !== undefined &&
    token !== "" &&
    !/[()]/.test(token) &&
    !OPERATORS.has(token.toUpperCase());

  const anyOf = (): boolean => {
    let allowed = allOf();
    while (peek() === "OR") {
      at++;
      allowed = allOf() || allowed;
    }
    return allowed;
  };
  const allOf = (): boolean => {
    let allowed = one();
    while (peek() === "AND") {
      at++;
      allowed = one() && allowed;
    }
    return allowed;
  };
  const one = (): boolean => {
    const token = tokens[at++];
    if (token === "(") {
      const allowed = anyOf();
      if (tokens[at++] !== ")") throw new SyntaxError(expression);
      return allowed;
    }
    if (!isId(token)) throw new SyntaxError(expression);
    let exceptionAllowed = true;
    if (peek() === "WITH") {
      at++;
      const exception = tokens[at++];
      if (!isId(exception)) throw new SyntaxError(expression);
      exceptionAllowed = LICENSE_EXCEPTIONS.some(
        (listed) => listed.toLowerCase() === exception.toLowerCase(),
      );
    }
    return exceptionAllowed && isListed(token, allowlist);
  };

  try {
    const allowed = anyOf();
    return at === tokens.length && allowed;
  } catch {
    return false;
  }
}

export function reviewedRecordFor(
  pkg: Pick<InstalledPackage, "name" | "version">,
  reviewed: readonly ReviewedRecord[],
): ReviewedRecord | undefined {
  return reviewed.find((record) => record.package === pkg.name && record.version === pkg.version);
}

// The license the rules judge: the license field, or the reviewed record when the field
// names no license.
export function licenseOf(
  pkg: InstalledPackage,
  reviewed: readonly ReviewedRecord[],
): string | undefined {
  return needsReview(pkg.declared) ? reviewedRecordFor(pkg, reviewed)?.license : pkg.declared;
}

export function checkLicenses(input: {
  shipped: readonly InstalledPackage[];
  buildTime: readonly InstalledPackage[];
  reviewed: readonly ReviewedRecord[];
}): string[] {
  const key = (pkg: InstalledPackage) => `${pkg.name}@${pkg.version}`;
  const shippedKeys = new Set(input.shipped.map(key));
  // A package in both trees ships, so only the shipped rules apply to it.
  const buildTimeOnly = input.buildTime.filter((pkg) => !shippedKeys.has(key(pkg)));
  const isBundler = (pkg: InstalledPackage) => BUNDLER_PACKAGES.includes(pkg.name);
  const trees = [
    {
      tree: "shipped",
      packages: [...input.shipped, ...buildTimeOnly.filter(isBundler)],
      allowlist: SHIPPED_LICENSES,
    },
    {
      tree: "build-time",
      packages: buildTimeOnly.filter((pkg) => !isBundler(pkg)),
      allowlist: BUILD_TIME_LICENSES,
    },
  ] as const;

  const problems = new Set<string>();
  for (const { tree, packages, allowlist } of trees) {
    for (const pkg of packages) {
      const license = licenseOf(pkg, input.reviewed);
      if (license === undefined) {
        const field =
          pkg.declared === undefined ? "no license field" : `the license field "${pkg.declared}"`;
        problems.add(
          `${key(pkg)} (${tree}) has ${field}. Read its files and add a record to ${REVIEWED_FILE}.`,
        );
      } else if (!isAllowed(license, allowlist)) {
        const source = needsReview(pkg.declared)
          ? `is recorded in ${REVIEWED_FILE} as`
          : "has the license";
        problems.add(
          `${key(pkg)} (${tree}) ${source} "${license}", which the ${tree} allowlist does not allow.`,
        );
      }
      // A record can exist only for its licenseText, so it must not contradict the field.
      const record = reviewedRecordFor(pkg, input.reviewed);
      if (
        record !== undefined &&
        !needsReview(pkg.declared) &&
        record.license.trim().toLowerCase() !== pkg.declared?.toLowerCase()
      ) {
        problems.add(
          `${key(pkg)} (${tree}) has the license field "${pkg.declared}", but its record in ${REVIEWED_FILE} says "${record.license}". Make them match.`,
        );
      }
    }
  }
  return [...problems];
}
