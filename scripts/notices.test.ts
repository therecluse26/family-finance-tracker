import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InstalledPackage, ReviewedRecord } from "./licenses.ts";
import { type LicenseText, noticesFor, readLicenseTexts, renderNotices } from "./notices.ts";

const pkg = (name: string, version: string, declared: string | undefined) =>
  ({ name, version, declared, path: `/fixture/node_modules/${name}` }) satisfies InstalledPackage;

const record = (fields: Partial<ReviewedRecord> & Pick<ReviewedRecord, "package" | "version">) => ({
  license: "MIT",
  reviewer: "A reviewer",
  date: "2026-11-03",
  ...fields,
});

const TEXTS: Record<string, LicenseText[]> = {
  "/fixture/node_modules/react": [{ file: "LICENSE", text: "MIT License\n\nCopyright Meta" }],
  "/fixture/node_modules/express-ejs-layouts": [
    { file: "LICENSE", text: "Copyright (c) 2012 Igor Soarez" },
  ],
};
const readTexts = (dir: string) => TEXTS[dir] ?? [];
const RECORDED: Record<string, string> = {
  "licenses/texts/no-file@1.0.0.txt": "ISC License\n\nCopyright (c) 2026 A Person",
};
const readRecorded = (file: string) => RECORDED[file];

describe("readLicenseTexts", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "fft-notices-"));
    const files: Record<string, string> = {
      LICENSE: "MIT License\n\nCopyright (c) 2026 A Person\n",
      "LICENSE-APACHE.md": "Apache License, Version 2.0\n",
      NOTICE: "A Project includes software from B Project.\n",
      "license.js": "export const license = 'not a license file';\n",
      "README.md": "# A package\n",
    };
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    mkdirSync(join(dir, "LICENSES"));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the license and notice files, and no code, folders, or other files", () => {
    expect(readLicenseTexts(dir)).toEqual([
      { file: "LICENSE", text: "MIT License\n\nCopyright (c) 2026 A Person" },
      { file: "LICENSE-APACHE.md", text: "Apache License, Version 2.0" },
      { file: "NOTICE", text: "A Project includes software from B Project." },
    ]);
  });
});

describe("noticesFor", () => {
  const check = (packages: InstalledPackage[], reviewed: ReviewedRecord[] = []) =>
    noticesFor(packages, reviewed, readTexts, readRecorded);

  it("fails a package with no license file and names it, even with a valid license field", () => {
    expect(check([pkg("no-file", "1.0.0", "ISC")])).toEqual({
      notices: [],
      problems: [
        'no-file@1.0.0 ships no license file. Save its license text in licenses/texts/ and name that file as "licenseText" in its record in licenses/reviewed.json.',
      ],
    });
  });

  it("fails a package whose only file is NOTICE, which is not a license file", () => {
    const notice = { file: "NOTICE", text: "A Project includes software from B Project." };
    const only = (readTexts: (dir: string) => LicenseText[], reviewed: ReviewedRecord[] = []) =>
      noticesFor([pkg("notice-only", "2.0.0", "Apache-2.0")], reviewed, readTexts, readRecorded);

    expect(only(() => [notice]).problems).toEqual([
      'notice-only@2.0.0 ships no license file. Save its license text in licenses/texts/ and name that file as "licenseText" in its record in licenses/reviewed.json.',
    ]);

    const reviewed = [
      record({
        package: "notice-only",
        version: "2.0.0",
        license: "Apache-2.0",
        licenseText: "licenses/texts/no-file@1.0.0.txt",
      }),
    ];
    expect(only(() => [notice], reviewed)).toEqual({
      notices: [
        expect.objectContaining({
          texts: [
            { file: "licenses/texts/no-file@1.0.0.txt", text: expect.stringContaining("ISC") },
            notice,
          ],
        }),
      ],
      problems: [],
    });
  });

  it.each(["LICENSE", "LICENCE.md", "COPYING", "license-mit"])(
    "counts %s as a license file",
    (file) => {
      expect(
        noticesFor([pkg("a", "1.0.0", "MIT")], [], () => [{ file, text: "text" }], readRecorded)
          .problems,
      ).toEqual([]);
    },
  );

  it("uses the license text a reviewed record names for a package with no license file", () => {
    const reviewed = [
      record({
        package: "no-file",
        version: "1.0.0",
        license: "ISC",
        licenseText: "licenses/texts/no-file@1.0.0.txt",
      }),
    ];

    expect(check([pkg("no-file", "1.0.0", "ISC")], reviewed)).toEqual({
      notices: [
        {
          name: "no-file",
          version: "1.0.0",
          license: "ISC",
          texts: [
            {
              file: "licenses/texts/no-file@1.0.0.txt",
              text: RECORDED["licenses/texts/no-file@1.0.0.txt"] as string,
            },
          ],
        },
      ],
      problems: [],
    });
  });

  it("fails when the recorded license text file is missing", () => {
    const reviewed = [
      record({ package: "no-file", version: "1.0.0", licenseText: "licenses/texts/gone.txt" }),
    ];

    expect(check([pkg("no-file", "1.0.0", "ISC")], reviewed).problems).toEqual([
      "no-file@1.0.0: licenses/texts/gone.txt, named in licenses/reviewed.json, is missing.",
    ]);
  });

  it.each([
    ["empty", ""],
    ["whitespace only", " \n\t\n"],
  ])("fails when the recorded license text file is %s", (_case, text) => {
    const reviewed = [
      record({ package: "no-file", version: "1.0.0", licenseText: "licenses/texts/blank.txt" }),
    ];
    const problems = noticesFor(
      [pkg("no-file", "1.0.0", "ISC")],
      reviewed,
      readTexts,
      () => text,
    ).problems;

    expect(problems).toEqual([
      "no-file@1.0.0: licenses/texts/blank.txt, named in licenses/reviewed.json, is empty.",
    ]);
  });

  it("fails a package whose license field names no license and has no record", () => {
    expect(check([pkg("react", "19.3.1", "SEE LICENSE IN LICENSE")]).problems).toEqual([
      "react@19.3.1 names no license the notices can use. Add a record to licenses/reviewed.json.",
    ]);
  });
});

describe("renderNotices", () => {
  const { notices, problems } = noticesFor(
    [
      pkg("react", "19.3.1", "MIT"),
      pkg("express-ejs-layouts", "2.5.1", undefined),
      pkg("no-file", "1.0.0", "ISC"),
      pkg("react", "19.3.1", "MIT"),
    ],
    [
      record({ package: "express-ejs-layouts", version: "2.5.1" }),
      record({
        package: "no-file",
        version: "1.0.0",
        license: "ISC",
        licenseText: "licenses/texts/no-file@1.0.0.txt",
      }),
    ],
    readTexts,
    readRecorded,
  );
  const text = renderNotices("Third-party notices for a test", notices);

  it("lists each package once, by name, with its version, license, and license text", () => {
    expect(problems).toEqual([]);
    expect(text).toBe(
      [
        "Third-party notices for a test",
        "",
        "Each entry gives a package's name, version, license, and license text.",
        "Packages: 3",
        "",
        "=".repeat(80),
        "express-ejs-layouts 2.5.1",
        "License: MIT",
        "=".repeat(80),
        "",
        "--- LICENSE ---",
        "",
        "Copyright (c) 2012 Igor Soarez",
        "",
        "=".repeat(80),
        "no-file 1.0.0",
        "License: ISC",
        "=".repeat(80),
        "",
        "--- licenses/texts/no-file@1.0.0.txt ---",
        "",
        "ISC License",
        "",
        "Copyright (c) 2026 A Person",
        "",
        "=".repeat(80),
        "react 19.3.1",
        "License: MIT",
        "=".repeat(80),
        "",
        "--- LICENSE ---",
        "",
        "MIT License",
        "",
        "Copyright Meta",
        "",
      ].join("\n"),
    );
  });
});
