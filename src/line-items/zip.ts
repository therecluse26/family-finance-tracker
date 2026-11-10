import { crc32, inflateRawSync } from "node:zlib";

// Reads one file out of an uploaded .zip archive (PKWARE APPNOTE 6.3.10), from its central
// directory, with node:zlib only (spec 14, Reading the file). It opens no other entry. Every check
// is on the archive's bytes as stored: an entry's name as the directory holds it, and its real size
// as it inflates, never only the size its header claims.

export type ZipLimits = {
  // The most entries the archive may hold.
  entries: number;
  // The most bytes its entries may unpack to, by their headers, and the most the opened entry may
  // really unpack to.
  unpackedBytes: number;
};

export const ZIP_LIMITS: ZipLimits = { entries: 500, unpackedBytes: 200 * 1024 * 1024 };

export type ZipEntry = { name: string; content: Uint8Array };
// Why the archive was refused, in words for the Member. It never quotes the archive's content.
export type ZipRefusal = { refused: string };

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_LOCATOR = 0x07064b50;
const END_SIZE = 22;
const MAX_COMMENT = 0xffff;
const STORED = 0;
const DEFLATE = 8;
// Bit 0: encrypted. Bit 6: strong encryption. Bit 11: the name is UTF-8.
const ENCRYPTED = 0x0001 | 0x0040;
const UTF8_NAME = 0x0800;
const ZIP64_SIZE = 0xffff_ffff;
const ZIP64_COUNT = 0xffff;

const NOT_A_ZIP = "The file is not a ZIP file, or it is damaged.";

const refuse = (refused: string): ZipRefusal => ({ refused });

// The end of the central directory: the last signature whose comment runs to the archive's end.
function findEnd(view: DataView): number | undefined {
  const last = view.byteLength - END_SIZE;
  for (let at = last; at >= Math.max(0, last - MAX_COMMENT); at--) {
    if (view.getUint32(at, true) !== END_OF_CENTRAL_DIRECTORY) continue;
    if (at + END_SIZE + view.getUint16(at + 20, true) === view.byteLength) return at;
  }
  return undefined;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters a name must not hold.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

// Why an entry's name, as stored, is skipped, or undefined when it may be read. A name that climbs
// out of a folder, starts at a root or a drive, holds a control character, or changes under Unicode
// compatibility folding (such as a full-width dot, which some tools read as ".") is skipped.
export function entryNameProblem(name: string): string | undefined {
  if (name.includes("..")) return "it holds ..";
  if (name.startsWith("/") || name.startsWith("\\")) return "it starts at a root";
  if (/^[A-Za-z]:/.test(name)) return "it names a drive";
  if (CONTROL.test(name)) return "it holds a control character";
  if (name.normalize("NFKC") !== name) return "it holds a character that folds to another";
  return undefined;
}

// The entry's name as stored: UTF-8 when its flag says so, else plain ASCII. Undefined for any
// other bytes, so the entry is skipped.
function nameOf(bytes: Uint8Array, flags: number): string | undefined {
  if ((flags & UTF8_NAME) === 0 && bytes.some((byte) => byte >= 0x80)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

// The last part of an entry's path, such as "Order History.csv".
export const baseName = (name: string) => name.split(/[\\/]/).at(-1) ?? "";

type Found = {
  name: string;
  nameBytes: Uint8Array;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  local: number;
};

// The one entry whose name passes the checks and `wanted`, with its content, or why the archive
// was refused. `missing` is the refusal when no entry is wanted.
export function readZipEntry(
  archive: Uint8Array,
  wanted: (name: string) => boolean,
  missing: string,
  limits: ZipLimits = ZIP_LIMITS,
): ZipEntry | ZipRefusal {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  if (archive.byteLength < END_SIZE) return refuse(NOT_A_ZIP);
  const end = findEnd(view);
  if (end === undefined) return refuse(NOT_A_ZIP);
  if (end >= 20 && view.getUint32(end - 20, true) === ZIP64_END_LOCATOR) {
    return refuse("The ZIP file uses ZIP64, which the app does not read.");
  }
  const disk = view.getUint16(end + 4, true);
  const directoryDisk = view.getUint16(end + 6, true);
  const onDisk = view.getUint16(end + 8, true);
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryStart = view.getUint32(end + 16, true);
  if (count === ZIP64_COUNT || directorySize === ZIP64_SIZE || directoryStart === ZIP64_SIZE) {
    return refuse("The ZIP file uses ZIP64, which the app does not read.");
  }
  if (disk !== 0 || directoryDisk !== 0 || onDisk !== count) {
    return refuse("The ZIP file is split into parts. Upload it as one file.");
  }
  if (count > limits.entries) {
    return refuse(`The ZIP file holds more than ${limits.entries} files.`);
  }
  if (directoryStart + directorySize > end) return refuse(NOT_A_ZIP);

  let at = directoryStart;
  let unpacked = 0;
  const found: Found[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || view.getUint32(at, true) !== CENTRAL_HEADER) return refuse(NOT_A_ZIP);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > end) return refuse(NOT_A_ZIP);
    if (compressed === ZIP64_SIZE || size === ZIP64_SIZE || local === ZIP64_SIZE) {
      return refuse("The ZIP file uses ZIP64, which the app does not read.");
    }
    unpacked += size;
    if (unpacked > limits.unpackedBytes) {
      return refuse(`The ZIP file unpacks to more than ${megabytes(limits.unpackedBytes)}.`);
    }
    const nameBytes = archive.subarray(at + 46, at + 46 + nameLength);
    const name = nameOf(nameBytes, flags);
    if (name !== undefined && entryNameProblem(name) === undefined && wanted(name)) {
      found.push({ name, nameBytes, flags, method, crc, compressed, size, local });
    }
    at = next;
  }
  if (at !== directoryStart + directorySize) return refuse(NOT_A_ZIP);

  const [entry, other] = found;
  if (entry === undefined) return refuse(missing);
  if (other !== undefined)
    return refuse(`The ZIP file holds more than one ${baseName(entry.name)}.`);
  return openEntry(archive, view, entry, directoryStart, limits);
}

function megabytes(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))} MB`;
}

function openEntry(
  archive: Uint8Array,
  view: DataView,
  entry: Found,
  directoryStart: number,
  limits: ZipLimits,
): ZipEntry | ZipRefusal {
  if ((entry.flags & ENCRYPTED) !== 0) {
    return refuse(`${baseName(entry.name)} is encrypted. Upload the file as Amazon sent it.`);
  }
  if (entry.method !== STORED && entry.method !== DEFLATE) {
    return refuse(`${baseName(entry.name)} is packed in a way the app does not read.`);
  }
  const { local } = entry;
  if (local + 30 > directoryStart || view.getUint32(local, true) !== LOCAL_HEADER) {
    return refuse(NOT_A_ZIP);
  }
  // The local header must name the same entry, packed the same way, as the directory.
  const nameLength = view.getUint16(local + 26, true);
  const extraLength = view.getUint16(local + 28, true);
  const localName = archive.subarray(local + 30, local + 30 + nameLength);
  if (
    view.getUint16(local + 6, true) !== entry.flags ||
    view.getUint16(local + 8, true) !== entry.method ||
    !sameBytes(localName, entry.nameBytes)
  ) {
    return refuse(NOT_A_ZIP);
  }
  const start = local + 30 + nameLength + extraLength;
  if (start + entry.compressed > directoryStart) return refuse(NOT_A_ZIP);
  const data = archive.subarray(start, start + entry.compressed);
  const tooBig = refuse(
    `${baseName(entry.name)} unpacks to more than ${megabytes(limits.unpackedBytes)}.`,
  );
  let content: Uint8Array;
  if (entry.method === STORED) {
    if (data.byteLength > limits.unpackedBytes) return tooBig;
    content = data;
  } else {
    try {
      // The real size is checked as it inflates: zlib stops past the limit.
      content = new Uint8Array(inflateRawSync(data, { maxOutputLength: limits.unpackedBytes }));
    } catch (error) {
      if (error instanceof RangeError) return tooBig;
      return refuse(NOT_A_ZIP);
    }
  }
  if (content.byteLength !== entry.size || crc32(content) !== entry.crc) {
    return refuse(`${baseName(entry.name)} is damaged in the ZIP file.`);
  }
  return { name: entry.name, content };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);
}
