import { describe, expect, it } from "vitest";
import { readPort } from "./port.ts";

describe("readPort", () => {
  it("defaults to 3000", () => {
    expect(readPort(undefined)).toBe(3000);
    expect(readPort("")).toBe(3000);
  });

  it("reads a set port", () => {
    expect(readPort("8080")).toBe(8080);
  });

  it.each(["0", "65536", "-1", "80.5", "abc", "3000x"])("refuses %s", (value) => {
    expect(() => readPort(value)).toThrow(/PORT must be/);
  });
});
