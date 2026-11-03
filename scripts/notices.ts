import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type InstalledPackage,
  licenseOf,
  REVIEWED_FILE,
  type ReviewedRecord,
  ROOT,
  reviewedRecordFor,
} from "./licenses.ts";

export type LicenseText = { file: string; text: string };

export type Notice = { name: string; version: string; license: string; texts: LicenseText[] };

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[-._][\w.-]*)?$/i;
const CODE_FILE = /\.(?:[cm]?[jt]sx?|json|map)$/i;

export function readLicenseTexts(dir: string): LicenseText[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && LICENSE_FILE.test(entry.name) && !CODE_FILE.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort()
    .map((file) => ({ file, text: readFileSync(join(dir, file), "utf8").trim() }));
}

function readRecordedText(file: string): string | undefined {
  const path = join(ROOT, file);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
}

// A NOTICE file is kept as an extra text, but it is not a license file.
const LICENSE_TEXT_FILE = /^(?:licen[cs]e|copying)/i;

// Every notice needs a license and a license text. A package that ships no license file
// needs a record in licenses/reviewed.json that names a file holding its text.
export function noticesFor(
  packages: readonly InstalledPackage[],
  reviewed: readonly ReviewedRecord[],
  readTexts: (dir: string) => LicenseText[] = readLicenseTexts,
  readRecorded: (file: string) => string | undefined = readRecordedText,
): { notices: Notice[]; problems: string[] } {
  const notices: Notice[] = [];
  const problems: string[] = [];
  for (const pkg of new Map(packages.map((pkg) => [pkg.path, pkg])).values()) {
    const id = `${pkg.name}@${pkg.version}`;
    const license = licenseOf(pkg, reviewed);
    const recorded = reviewedRecordFor(pkg, reviewed)?.licenseText;
    let texts = readTexts(pkg.path);
    let hasLicenseText = texts.some(({ file }) => LICENSE_TEXT_FILE.test(file));
    if (!hasLicenseText && recorded === undefined) {
      problems.push(
        `${id} ships no license file. Save its license text in licenses/texts/ and name that file as "licenseText" in its record in ${REVIEWED_FILE}.`,
      );
    } else if (!hasLicenseText && recorded !== undefined) {
      const text = readRecorded(recorded);
      if (text === undefined) {
        problems.push(`${id}: ${recorded}, named in ${REVIEWED_FILE}, is missing.`);
      } else {
        texts = [{ file: recorded, text }, ...texts];
        hasLicenseText = true;
      }
    }
    if (license === undefined) {
      problems.push(
        `${id} names no license the notices can use. Add a record to ${REVIEWED_FILE}.`,
      );
    }
    if (license !== undefined && hasLicenseText) {
      notices.push({ name: pkg.name, version: pkg.version, license, texts });
    }
  }
  return { notices, problems };
}

const RULE = "=".repeat(80);

export function renderNotices(title: string, notices: readonly Notice[]): string {
  const sorted = [...notices].sort(
    (a, b) => a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en"),
  );
  const sections = sorted.map((notice) => {
    const heading = [RULE, `${notice.name} ${notice.version}`, `License: ${notice.license}`, RULE];
    const texts = notice.texts.map(({ file, text }) => `--- ${file} ---\n\n${text}`);
    return [heading.join("\n"), ...texts].join("\n\n");
  });
  const intro = [
    title,
    "",
    "Each entry gives a package's name, version, license, and license text.",
    `Packages: ${sorted.length}`,
  ].join("\n");
  return `${[intro, ...sections].join("\n\n")}\n`;
}
