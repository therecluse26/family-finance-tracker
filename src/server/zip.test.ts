import { describe, expect, it } from "vitest";
import { readZip } from "./testing.ts";
import { zipStream } from "./zip.ts";

// The streamed .zip writer behind the data export (spec 11, Data export).

const AT = new Date("2026-11-05T14:30:20.000Z");

async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function* pieces(...texts: string[]): AsyncGenerator<string> {
  for (const text of texts) yield text;
}

describe("the .zip writer", () => {
  it("writes each file, in order, so a strict reader reads it back", async () => {
    const zip = await bytesOf(
      zipStream(
        [
          { name: "a.csv", content: () => pieces("id,amount\r\n", "1,-12.34\r\n") },
          { name: "empty.json", content: () => pieces() },
          { name: "café.json", content: () => pieces('{"name":"Crème brûlée ☕"}') },
        ],
        AT,
      ),
    );

    const files = readZip(zip);
    const text = (name: string) => new TextDecoder().decode(files.get(name));
    expect([...files.keys()]).toEqual(["a.csv", "empty.json", "café.json"]);
    expect(text("a.csv")).toBe("id,amount\r\n1,-12.34\r\n");
    expect(text("empty.json")).toBe("");
    expect(text("café.json")).toBe('{"name":"Crème brûlée ☕"}');
  });

  it("deflates what it writes", async () => {
    const line = "2026-11-05,Groceries,-12.34\r\n";
    const zip = await bytesOf(
      zipStream([{ name: "big.csv", content: () => pieces(...Array(10_000).fill(line)) }], AT),
    );

    expect(zip.length).toBeLessThan(line.length * 100);
    expect(new TextDecoder().decode(readZip(zip).get("big.csv"))).toBe(line.repeat(10_000));
  });

  it("reads a file's content only as fast as the reader takes the bytes", async () => {
    let made = 0;
    async function* endless(): AsyncGenerator<string> {
      for (;;) {
        made += 1;
        // Random text, which deflate cannot shrink much.
        yield `${crypto.randomUUID()},${crypto.randomUUID()}\r\n`;
      }
    }
    const reader = zipStream([{ name: "endless.csv", content: endless }], AT).getReader();

    let read = 0;
    while (read < 200_000) {
      const { value } = await reader.read();
      read += value?.length ?? 0;
    }
    await reader.cancel();

    // About 74 bytes a line: what was read, plus what the streams' queues hold.
    expect(made * 74).toBeLessThan(read + 1_000_000);
  });

  it("fails the stream when a file's content fails, so no archive looks whole", async () => {
    async function* failing(): AsyncGenerator<string> {
      yield "id\r\n";
      throw new Error("The read failed.");
    }

    await expect(bytesOf(zipStream([{ name: "a.csv", content: failing }], AT))).rejects.toThrow(
      "The read failed.",
    );
  });
});
