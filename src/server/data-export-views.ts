// What the data export route answers. This file imports nothing, so the web app's type check can
// follow it through api.ts.

export type DataExportRoutes = {
  // The ZIP file (spec 11, Data export): its name, such as family-finance-data-2026-11-05.zip,
  // and its bytes, written as the reader takes them.
  download(): Promise<{ fileName: string; stream: ReadableStream<Uint8Array> }>;
};
