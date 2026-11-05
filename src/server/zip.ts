import { Duplex } from "node:stream";
import { crc32, createDeflateRaw } from "node:zlib";

// A .zip file written as a stream (PKWARE APPNOTE 6.3.10), for the data export (spec 11, Data
// export). Each file is deflated as its content comes, and its CRC-32 and sizes follow it in a data
// descriptor, so no file is held whole in memory. The stream pulls each file's content only as its
// reader asks for more.

export type ZipFile = {
  // The file's name in the archive, such as "transactions.csv".
  name: string;
  // Its content, a piece at a time. Text is written as UTF-8.
  content: () => AsyncIterable<string | Uint8Array>;
};

const LOCAL_HEADER = 0x04034b50;
const DATA_DESCRIPTOR = 0x08074b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
// 2.0: deflate.
const VERSION = 20;
// Bit 3: the CRC-32 and sizes follow the data. Bit 11: the name is UTF-8.
const FLAGS = 0x0008 | 0x0800;
const DEFLATE = 8;
// Without ZIP64, each size and offset has 4 bytes.
const MAX_SIZE = 0xffff_ffff;

type Written = { name: Uint8Array; crc: number; compressed: number; size: number; offset: number };

// The DOS date and time a .zip header holds, as the clock reads in UTC.
function dosTime(at: Date): { time: number; date: number } {
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
    date: ((at.getUTCFullYear() - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

function header(size: number, fill: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(size);
  fill(new DataView(bytes.buffer));
  return bytes;
}

function checkSize(value: number): number {
  if (value > MAX_SIZE) throw new Error("The archive is too big for a .zip file without ZIP64.");
  return value;
}

const encoder = new TextEncoder();

async function* bytesOf(content: AsyncIterable<string | Uint8Array>): AsyncGenerator<Uint8Array> {
  for await (const piece of content) {
    const bytes = typeof piece === "string" ? encoder.encode(piece) : piece;
    if (bytes.length > 0) yield bytes;
  }
}

async function* zipPieces(files: readonly ZipFile[], modified: Date): AsyncGenerator<Uint8Array> {
  const { time, date } = dosTime(modified);
  const written: Written[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const start = offset;
    const local = header(30 + name.length, (view) => {
      view.setUint32(0, LOCAL_HEADER, true);
      view.setUint16(4, VERSION, true);
      view.setUint16(6, FLAGS, true);
      view.setUint16(8, DEFLATE, true);
      view.setUint16(10, time, true);
      view.setUint16(12, date, true);
      // The CRC-32 and sizes, 0 here, are in the data descriptor.
      view.setUint16(26, name.length, true);
    });
    local.set(name, 30);
    offset += local.length;
    yield local;

    let crc = 0;
    let size = 0;
    const counted = async function* () {
      for await (const bytes of bytesOf(file.content())) {
        crc = crc32(bytes, crc);
        size += bytes.length;
        yield bytes;
      }
    };
    let compressed = 0;
    // Level 1 is a few times faster than the default and makes a file little larger.
    const deflated = ReadableStream.from(counted()).pipeThrough(
      Duplex.toWeb(createDeflateRaw({ level: 1 })),
    );
    for await (const bytes of deflated) {
      compressed += bytes.length;
      offset += bytes.length;
      yield bytes;
    }
    checkSize(size);
    checkSize(compressed);
    yield header(16, (view) => {
      view.setUint32(0, DATA_DESCRIPTOR, true);
      view.setUint32(4, crc, true);
      view.setUint32(8, compressed, true);
      view.setUint32(12, size, true);
    });
    offset += 16;
    written.push({ name, crc, compressed, size, offset: checkSize(start) });
  }

  const directoryStart = offset;
  for (const file of written) {
    const central = header(46 + file.name.length, (view) => {
      view.setUint32(0, CENTRAL_HEADER, true);
      view.setUint16(4, VERSION, true);
      view.setUint16(6, VERSION, true);
      view.setUint16(8, FLAGS, true);
      view.setUint16(10, DEFLATE, true);
      view.setUint16(12, time, true);
      view.setUint16(14, date, true);
      view.setUint32(16, file.crc, true);
      view.setUint32(20, file.compressed, true);
      view.setUint32(24, file.size, true);
      view.setUint16(28, file.name.length, true);
      view.setUint32(42, file.offset, true);
    });
    central.set(file.name, 46);
    offset += central.length;
    yield central;
  }
  yield header(22, (view) => {
    view.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
    view.setUint16(8, written.length, true);
    view.setUint16(10, written.length, true);
    view.setUint32(12, checkSize(offset - directoryStart), true);
    view.setUint32(16, checkSize(directoryStart), true);
  });
}

// The .zip file of these files, in this order, as a stream of bytes. Each file's content is read
// only when the stream reaches it, and only as fast as the reader takes the bytes.
export function zipStream(files: readonly ZipFile[], modified: Date): ReadableStream<Uint8Array> {
  return ReadableStream.from(zipPieces(files, modified));
}
