import { readZipEntry } from "./zip-table.ts";

// A small reader for the .xlsx tables BLS and USDA publish. It reads each sheet's cells as text,
// so no spreadsheet package is needed. It reads stored values only: no styles, no formulas, and
// no dates.

// A sheet's cells as text, by row and column from 0. A cell with nothing in it is "".
export type Sheet = string[][];

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
    return ENTITIES[name] ?? whole;
  });
}

// The text of an element's <t> runs, joined. Rich text splits one string into several runs.
function textOf(xml: string): string {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map((match) => decode(match[1] ?? ""))
    .join("");
}

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return match === null ? undefined : decode(match[1] ?? "");
}

// The 0-based column of a cell reference such as "C12".
function columnOf(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? "";
  let column = 0;
  for (const letter of letters) column = column * 26 + (letter.charCodeAt(0) - 64);
  return column - 1;
}

function entry(archive: Uint8Array, path: string): string | undefined {
  try {
    return new TextDecoder().decode(readZipEntry(archive, (name) => name === path));
  } catch (error) {
    if (error instanceof Error && error.message === "The archive holds no such file.") {
      return undefined;
    }
    throw error;
  }
}

function parseSheet(xml: string, strings: readonly string[]): Sheet {
  const rows: Sheet = [];
  let nextRow = 0;
  for (const rowMatch of xml.matchAll(/<row(\s[^>]*)?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowRef = attribute(rowMatch[1] ?? "", "r");
    const at = rowRef === undefined ? nextRow : Number(rowRef) - 1;
    nextRow = at + 1;
    const cells: string[] = [];
    let nextColumn = 0;
    for (const cell of (rowMatch[2] ?? "").matchAll(/<c(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = cell[1] ?? "";
      const ref = attribute(tag, "r");
      const column = ref === undefined ? nextColumn : columnOf(ref);
      nextColumn = column + 1;
      const body = cell[2] ?? "";
      const type = attribute(tag, "t");
      const value = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let text = "";
      if (type === "inlineStr") text = textOf(body);
      else if (type === "s") text = strings[Number(value)] ?? "";
      else if (value !== undefined) text = decode(value);
      while (cells.length < column) cells.push("");
      cells[column] = text;
    }
    while (rows.length < at) rows.push([]);
    rows[at] = cells;
  }
  return rows;
}

// Every sheet of an .xlsx file, by its name, in the workbook's order.
export function readXlsx(archive: Uint8Array): Map<string, Sheet> {
  const workbook = entry(archive, "xl/workbook.xml");
  if (workbook === undefined) throw new Error("The file is not an .xlsx workbook.");
  const relations = new Map<string, string>();
  for (const [tag] of (entry(archive, "xl/_rels/workbook.xml.rels") ?? "").matchAll(
    /<Relationship\s[^>]*>/g,
  )) {
    const id = attribute(tag, "Id");
    const target = attribute(tag, "Target");
    if (id === undefined || target === undefined) continue;
    relations.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const strings = [
    ...(entry(archive, "xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g),
  ].map((match) => textOf(match[1] ?? ""));
  const sheets = new Map<string, Sheet>();
  for (const [tag] of workbook.matchAll(/<sheet\s[^>]*>/g)) {
    const name = attribute(tag, "name");
    const path = relations.get(attribute(tag, "r:id") ?? "");
    const xml = path === undefined ? undefined : entry(archive, path);
    if (name === undefined || xml === undefined) {
      throw new Error("The workbook names a sheet it does not hold.");
    }
    sheets.set(name, parseSheet(xml, strings));
  }
  return sheets;
}
