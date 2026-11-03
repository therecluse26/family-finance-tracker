import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BUILD_TIME_LICENSES,
  BUNDLER_PACKAGES,
  checkLicenses,
  declaredLicense,
  isAllowed,
  needsReview,
  parsePnpmLicenses,
  parsePnpmTreePaths,
  parseReviewed,
  productionPackages,
  type ReviewedRecord,
  readReviewed,
  SHIPPED_LICENSES,
} from "./licenses.ts";
import { noticesFor } from "./notices.ts";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

const manifests = fixture("package-manifests.json") as Record<string, unknown>;
const manifestAt = (dir: string) => manifests[dir];
const shipped = parsePnpmLicenses(fixture("licenses-shipped.json"), manifestAt);
const buildTime = parsePnpmLicenses(fixture("licenses-build-time.json"), manifestAt);

const record = (pkg: string, version: string, license: string): ReviewedRecord => ({
  package: pkg,
  version,
  license,
  reviewer: "A reviewer",
  date: "2026-11-03",
});
const REVIEWED = [record("express-ejs-layouts", "2.5.1", "MIT")];

describe("the license check on fixture JSON", () => {
  const problems = checkLicenses({ shipped, buildTime, reviewed: REVIEWED });
  const problemFor = (pkg: string) => problems.find((problem) => problem.startsWith(`${pkg} `));

  it.each([
    ["an -or-later form", "or-later-jobs@1.17.0"],
    ["a dual license with one option on the list", "dual-licensed@3.1.0"],
    ["a CC-BY-4.0 build-time tool", "caniuse-lite@1.0.30001700"],
    ["a reviewed package with no license field", "express-ejs-layouts@2.5.1"],
    ["a plain MIT package in both trees", "react@19.3.1"],
    ["each version of a package with two", "magic-string@1.4.5"],
    ["an exception on the exception list", "with-llvm-exception@17.0.0"],
    ["an old licenses list with one allowed option", "legacy-list@0.5.0"],
    ["a bundler package with a shipped license", "vite@8.3.5"],
  ])("passes %s (%s)", (_case, pkg) => {
    expect(problemFor(pkg)).toBeUndefined();
  });

  it.each([
    ["a CC-BY-4.0 shipped package", "shipped-data@1.0.30001700", "shipped", "CC-BY-4.0"],
    ["GPL-2.0-only", "gpl-two@2.0.0", "shipped", "GPL-2.0-only"],
    ["SSPL", "server-side@7.0.0", "shipped", "SSPL-1.0"],
    ["BUSL, even as a build-time tool", "business-source@1.0.0", "build-time", "BUSL-1.1"],
    ["a non-commercial license", "non-commercial@2.2.0", "build-time", "CC-BY-NC-4.0"],
    [
      "the Commons Clause written as an exception",
      "with-commons-clause@1.0.0",
      "shipped",
      "Apache-2.0 WITH Commons-Clause",
    ],
    [
      "a bundler package as shipped code, not a build tool",
      "rolldown@1.2.16",
      "shipped",
      "CC-BY-4.0",
    ],
  ])("fails %s and names the package", (_case, pkg, tree, license) => {
    expect(problemFor(pkg)).toBe(
      `${pkg} (${tree}) has the license "${license}", which the ${tree} allowlist does not allow.`,
    );
  });

  it.each([
    ["no license field", "unreviewed@0.1.0", "no license field"],
    [
      "SEE LICENSE IN, though pnpm guessed MIT from a Commons Clause LICENSE file",
      "commons-clause-lib@1.0.0",
      'the license field "SEE LICENSE IN LICENSE"',
    ],
    ["UNLICENSED", "proprietary-lib@2.0.0", 'the license field "UNLICENSED"'],
    ["an old licenses list with an empty entry", "empty-legacy-list@0.1.0", "no license field"],
  ])("fails %s without a reviewed record", (_case, pkg, field) => {
    expect(problemFor(pkg)).toBe(
      `${pkg} (shipped) has ${field}. Read its files and add a record to licenses/reviewed.json.`,
    );
  });

  it("reports nothing else", () => {
    expect(problems).toHaveLength(11);
  });
});

describe("reviewed records", () => {
  const only = (name: string) => shipped.filter((pkg) => pkg.name === name);
  const check = (name: string, reviewed: ReviewedRecord[]) =>
    checkLicenses({ shipped: only(name), buildTime: [], reviewed });

  it("let a SEE LICENSE IN package pass with an allowed license", () => {
    expect(check("commons-clause-lib", [record("commons-clause-lib", "1.0.0", "MIT")])).toEqual([]);
  });

  it("still have to name an allowed license", () => {
    expect(
      check("commons-clause-lib", [
        record("commons-clause-lib", "1.0.0", "MIT WITH LicenseRef-Commons-Clause"),
      ]),
    ).toEqual([
      'commons-clause-lib@1.0.0 (shipped) is recorded in licenses/reviewed.json as "MIT WITH LicenseRef-Commons-Clause", which the shipped allowlist does not allow.',
    ]);
  });

  it("apply only to the reviewed version", () => {
    expect(
      check("express-ejs-layouts", [record("express-ejs-layouts", "2.5.0", "MIT")]),
    ).toHaveLength(1);
  });

  it("do not override a license field that names a license, and must match it", () => {
    expect(check("gpl-two", [record("gpl-two", "2.0.0", "MIT")])).toEqual([
      'gpl-two@2.0.0 (shipped) has the license "GPL-2.0-only", which the shipped allowlist does not allow.',
      'gpl-two@2.0.0 (shipped) has the license field "GPL-2.0-only", but its record in licenses/reviewed.json says "MIT". Make them match.',
    ]);
  });

  it("fail when they give another license than the package's license field", () => {
    expect(check("react", [record("react", "19.3.1", "GPL-2.0-only")])).toEqual([
      'react@19.3.1 (shipped) has the license field "MIT", but its record in licenses/reviewed.json says "GPL-2.0-only". Make them match.',
    ]);
  });

  it("may exist only for licenseText when they give the same license as the field", () => {
    const withText = {
      ...record("react", "19.3.1", "mit"),
      licenseText: "licenses/texts/react@19.3.1.txt",
    };

    expect(check("react", [withText])).toEqual([]);
  });

  // licenseText serves the notices, which cover only shipped and bundled packages, so the
  // build checks it, not the license check.
  it("need no licenseText in the license check", () => {
    const tool = buildTime.filter((pkg) => pkg.name === "business-source");
    const noField = tool.map((pkg) => ({ ...pkg, declared: undefined }));

    expect(
      checkLicenses({
        shipped: [],
        buildTime: noField,
        reviewed: [record("business-source", "1.0.0", "MIT")],
      }),
    ).toEqual([]);
  });
});

describe("licenses/reviewed.json", () => {
  it("ships with the express-ejs-layouts record", () => {
    expect(readReviewed()).toContainEqual(
      expect.objectContaining({ package: "express-ejs-layouts", version: "2.5.1", license: "MIT" }),
    );
  });

  it("reads a licenseText file in licenses/texts/", () => {
    const withText = { ...REVIEWED[0], licenseText: "licenses/texts/a-package@1.0.0.txt" };

    expect(parseReviewed([withText])).toEqual([withText]);
  });

  it.each([
    ["a record that is not a list", {}, /must hold a JSON list/],
    ["a missing reviewer", [{ ...REVIEWED[0], reviewer: undefined }], /needs "reviewer"/],
    ["an empty license", [{ ...REVIEWED[0], license: " " }], /needs "license"/],
    ["a date that is not a date", [{ ...REVIEWED[0], date: "2026-02-30" }], /YYYY-MM-DD/],
    [
      "a licenseText outside licenses/texts/",
      [{ ...REVIEWED[0], licenseText: "licenses/texts/../../package.json" }],
      /licenses\/texts\//,
    ],
  ])("refuses %s", (_case, json, message) => {
    expect(() => parseReviewed(json)).toThrow(message);
  });
});

describe("isAllowed", () => {
  it.each([
    "MIT",
    "mit",
    "Apache-2.0",
    "GPL-3.0",
    "GPL-3.0-only",
    "GPL-3.0-or-later",
    "GPL-3.0+",
    "LGPL-2.1-or-later",
    "AGPL-3.0-only",
    "BlueOak-1.0.0",
    "(MIT OR Apache-2.0)",
    "MIT OR GPL-2.0-only",
    "GPL-2.0-only OR MIT",
    "MIT AND ISC",
    "(MIT AND Zlib) OR Apache-2.0",
    "Apache-2.0 WITH LLVM-exception",
    "GPL-3.0-or-later WITH GCC-exception-3.1",
    "GPL-3.0-only WITH Classpath-exception-2.0",
  ])("allows %s for shipped code", (expression) => {
    expect(isAllowed(expression, SHIPPED_LICENSES)).toBe(true);
  });

  it.each([
    "CC-BY-4.0",
    "GPL-2.0",
    "GPL-2.0-only",
    "GPL-2.0-or-later",
    "GPL-2.0-only WITH Classpath-exception-2.0",
    "Apache-2.0 WITH Commons-Clause",
    "MIT WITH Commons-Clause",
    "MIT WITH LicenseRef-NonCommercial",
    "GPL-3.0 WITH LicenseRef-no-commercial-use",
    "MIT AND GPL-2.0-only",
    "SSPL-1.0",
    "BUSL-1.1",
    "CC-BY-NC-4.0",
    "Elastic-2.0",
    "LicenseRef-Commercial",
    "UNLICENSED",
    "Unknown",
    "SEE LICENSE IN LICENSE.md",
    "Apache 2.0",
    "",
    "(MIT",
    "MIT OR",
    "MIT WITH",
    "OR MIT",
  ])("refuses %j for shipped code", (expression) => {
    expect(isAllowed(expression, SHIPPED_LICENSES)).toBe(false);
  });

  it("allows CC-BY-4.0 only for build-time tools", () => {
    expect(isAllowed("CC-BY-4.0", BUILD_TIME_LICENSES)).toBe(true);
    expect(isAllowed("CC-BY-4.0", SHIPPED_LICENSES)).toBe(false);
  });
});

describe("the production list", () => {
  // A driver whose native binary is an optional dependency, as libsql's is.
  const store = "/fixture/node_modules/.pnpm";
  const DRIVER = `${store}/db-driver@1.0.0/node_modules/db-driver`;
  const NATIVE = `${store}/@db+native-linux-x64@1.0.0/node_modules/@db/native-linux-x64`;
  const TOOL = `${store}/build-tool@2.0.0/node_modules/build-tool`;
  const entry = (name: string, version: string, path: string, license = "MIT") => ({
    name,
    versions: [version],
    paths: [path],
    license,
  });
  const licenses = (native: string) => ({
    MIT: [entry("db-driver", "1.0.0", DRIVER), entry("build-tool", "2.0.0", TOOL)],
    [native]: [entry("@db/native-linux-x64", "1.0.0", NATIVE, native)],
  });
  const manifestFor = (native: string) => (dir: string) => ({
    license: dir === NATIVE ? native : "MIT",
  });
  // pnpm licenses list --prod --json leaves out the optional native package.
  const LISTED_PROD = { MIT: [entry("db-driver", "1.0.0", DRIVER)] };
  // pnpm list --prod --depth Infinity --json. It names every optional binary, installed or not.
  const TREE = [
    {
      name: "app",
      path: "/fixture",
      dependencies: {
        "db-driver": {
          version: "1.0.0",
          path: DRIVER,
          dependencies: {
            "@db/native-linux-x64": { version: "1.0.0", path: NATIVE },
            "@db/native-darwin-arm64": {
              version: "1.0.0",
              path: `${store}/@db+native-darwin-arm64@1.0.0/node_modules/@db/native-darwin-arm64`,
            },
          },
        },
      },
    },
  ];
  const shippedWith = (native: string) =>
    productionPackages(
      parsePnpmLicenses(LISTED_PROD, manifestFor(native)),
      parsePnpmLicenses(licenses(native), manifestFor(native)),
      parsePnpmTreePaths(TREE),
    );

  it("takes an installed optional dependency that pnpm licenses list --prod leaves out", () => {
    expect(shippedWith("MIT").map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual([
      "db-driver@1.0.0",
      "@db/native-linux-x64@1.0.0",
    ]);
  });

  it("fails the notices when that optional package ships no license file", () => {
    const readTexts = (dir: string) => (dir === DRIVER ? [{ file: "LICENSE", text: "MIT" }] : []);

    expect(noticesFor(shippedWith("MIT"), [], readTexts).problems).toEqual([
      '@db/native-linux-x64@1.0.0 ships no license file. Save its license text in licenses/texts/ and name that file as "licenseText" in its record in licenses/reviewed.json.',
    ]);
  });

  it("fails the license check when that optional package's license is not allowed", () => {
    expect(
      checkLicenses({ shipped: shippedWith("SSPL-1.0"), buildTime: [], reviewed: [] }),
    ).toEqual([
      '@db/native-linux-x64@1.0.0 (shipped) has the license "SSPL-1.0", which the shipped allowlist does not allow.',
    ]);
  });

  it.each([
    ["an object", {}],
    ["a project that is not an object", ["app"]],
    ["an entry without a path", [{ dependencies: { a: { version: "1.0.0" } } }]],
  ])("refuses pnpm list output that is %s", (_case, json) => {
    expect(() => parsePnpmTreePaths(json)).toThrow(/unexpected shape/);
  });
});

describe("parsePnpmLicenses", () => {
  it("judges the package's own license field, not pnpm's guess", () => {
    expect(shipped.find((pkg) => pkg.name === "commons-clause-lib")).toMatchObject({
      declared: "SEE LICENSE IN LICENSE",
    });
  });

  it("gives each installed version its own entry", () => {
    expect(buildTime.filter((pkg) => pkg.name === "magic-string")).toEqual([
      expect.objectContaining({ version: "0.30.21", path: expect.stringContaining("@0.30.21/") }),
      expect.objectContaining({ version: "1.4.5", path: expect.stringContaining("@1.4.5/") }),
    ]);
  });

  it.each([
    ["a list", []],
    ["a group that is not a list", { MIT: {} }],
    ["an entry without paths", { MIT: [{ name: "a", versions: ["1.0.0"], license: "MIT" }] }],
    [
      "more versions than paths",
      { MIT: [{ name: "a", versions: ["1.0.0", "2.0.0"], paths: ["/a"], license: "MIT" }] },
    ],
  ])("refuses %s", (_case, json) => {
    expect(() => parsePnpmLicenses(json, () => ({}))).toThrow(/unexpected shape/);
  });
});

describe("declaredLicense", () => {
  it.each([
    [{ license: "MIT" }, "MIT"],
    [{ license: " MIT " }, "MIT"],
    [{ license: "SEE LICENSE IN LICENSE" }, "SEE LICENSE IN LICENSE"],
    [{ license: { type: "ISC", url: "https://example.com" } }, "ISC"],
    [{ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] }, "MIT OR Apache-2.0"],
    [{ name: "a" }, undefined],
    [{ license: "" }, undefined],
    [{ license: {} }, undefined],
    [{ license: ["MIT"] }, undefined],
    [{ licenses: [] }, undefined],
    [{ licenses: [{}] }, undefined],
    [{ licenses: [{ type: "" }] }, undefined],
    [{ licenses: [{ type: "MIT" }, {}] }, undefined],
    [undefined, undefined],
  ])("reads %j as %j", (manifest, expected) => {
    expect(declaredLicense(manifest)).toBe(expected);
  });
});

describe("needsReview", () => {
  it.each([
    [undefined, true],
    ["SEE LICENSE IN LICENSE", true],
    ["See license in EULA.txt", true],
    ["SEE LICENCE IN LICENCE", true],
    ["UNLICENSED", true],
    ["MIT", false],
    ["Unlicense", false],
  ])("gives %j: %s", (declared, expected) => {
    expect(needsReview(declared)).toBe(expected);
  });
});

describe("BUNDLER_PACKAGES", () => {
  it("names only Vite and Rolldown", () => {
    expect(BUNDLER_PACKAGES).toEqual(["vite", "rolldown"]);
  });
});
