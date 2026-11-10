// A CSV reader (RFC 4180) for an uploaded order file (spec 14, Reading the file): comma-separated,
// with `"` quotes, `""` for a quote inside them, and line breaks inside quotes. A line ends in LF or
// CRLF. A leading byte order mark is dropped. It never quotes the file in what it returns.

// One record of the file. `row` counts the records from 1, the header's, as a spreadsheet numbers
// its rows: a quoted line break does not start a new row.
export type CsvRecord = { row: number; fields: string[] };

export type CsvFile = {
  header: string[];
  records: CsvRecord[];
  // The row numbers of data rows skipped because their quotes are broken, or because they have
  // more or fewer fields than the header.
  brokenRows: number[];
  wrongFieldCounts: number[];
};

export type CsvRefusal = { refused: string };

export const MAX_CSV_ROWS = 200_000;

const QUOTE = 34;
const COMMA = 44;
const LF = 10;
const CR = 13;

// Each record, with whether its quotes are broken: a quote inside a field that is not quoted, text
// after a closing quote, or a quote left open at the end of the file.
function* records(text: string): Generator<{ fields: string[]; broken: boolean }> {
  const length = text.length;
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (at < length) {
    const fields: string[] = [];
    let broken = false;
    for (;;) {
      let field = "";
      if (text.charCodeAt(at) === QUOTE) {
        let from = at + 1;
        for (;;) {
          const close = text.indexOf('"', from);
          if (close === -1) {
            broken = true;
            field += text.slice(from);
            at = length;
            break;
          }
          field += text.slice(from, close);
          if (text.charCodeAt(close + 1) !== QUOTE) {
            at = close + 1;
            break;
          }
          field += '"';
          from = close + 2;
        }
        if (text.charCodeAt(at) === CR && (at + 1 === length || text.charCodeAt(at + 1) === LF)) {
          at += 1;
        }
        // Text after the closing quote breaks the record, up to the field's end.
        if (at < length && text.charCodeAt(at) !== COMMA && text.charCodeAt(at) !== LF) {
          broken = true;
          while (at < length && text.charCodeAt(at) !== COMMA && text.charCodeAt(at) !== LF) at++;
        }
      } else {
        let end = at;
        for (; end < length; end++) {
          const code = text.charCodeAt(end);
          if (code === COMMA || code === LF) break;
          if (code === QUOTE) broken = true;
        }
        field = text.slice(at, end);
        if (field.endsWith("\r") && (end === length || text.charCodeAt(end) === LF)) {
          field = field.slice(0, -1);
        }
        at = end;
      }
      fields.push(field);
      if (at >= length) break;
      at += 1;
      if (text.charCodeAt(at - 1) === LF) break;
      // After a comma at the very end, one empty field is left.
      if (at >= length) {
        fields.push("");
        break;
      }
    }
    yield { fields, broken };
  }
}

// The file's header and data records, or why it was refused. An empty line is no record. A file
// with more than `maxRows` data rows is refused before any row is used.
export function readCsv(text: string, maxRows: number = MAX_CSV_ROWS): CsvFile | CsvRefusal {
  let header: string[] | undefined;
  const kept: CsvRecord[] = [];
  const brokenRows: number[] = [];
  const wrongFieldCounts: number[] = [];
  let row = 0;
  for (const record of records(text)) {
    if (record.fields.length === 1 && record.fields[0] === "" && !record.broken) continue;
    row += 1;
    if (header === undefined) {
      if (record.broken) return { refused: "The file's header row could not be read." };
      header = record.fields;
      continue;
    }
    if (row - 1 > maxRows) {
      return { refused: `The file has more than ${maxRows.toLocaleString("en-US")} rows.` };
    }
    if (record.broken) brokenRows.push(row);
    else if (record.fields.length !== header.length) wrongFieldCounts.push(row);
    else kept.push({ row, fields: record.fields });
  }
  if (header === undefined) return { refused: "The file is empty." };
  return { header, records: kept, brokenRows, wrongFieldCounts };
}
