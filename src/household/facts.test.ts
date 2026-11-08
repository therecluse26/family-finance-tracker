import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginTables, readSetupSteps } from "../db/index.ts";
import { newTestDatabase, type TestDatabase } from "../db/testing.ts";
import {
  type HouseholdFactsEdit,
  type HouseholdFactsInput,
  householdTimeZone,
  onHouseholdFactsEdited,
  readHouseholdFacts,
  saveHouseholdFacts,
} from "./index.ts";

// The Household facts, through the household module, on a real app.db.

const NEW_YORK: HouseholdFactsInput = { zipCode: "10001", ages: [41, 39, 8, 0], rentOrOwn: "rent" };

describe("the Household facts", () => {
  let test: TestDatabase;
  const memberId = "member-a";
  const edits: HouseholdFactsEdit[] = [];
  let stopListening: () => void;

  beforeEach(async () => {
    test = await newTestDatabase();
    const at = new Date("2026-11-03T12:00:00Z");
    await test.database.insert(loginTables.user).values({
      id: memberId,
      name: "Alice",
      email: "alice@example.com",
      createdAt: at,
      updatedAt: at,
    });
    edits.length = 0;
    stopListening = onHouseholdFactsEdited((edit) => {
      edits.push(edit);
    });
  });

  afterEach(() => {
    stopListening();
    test.close();
  });

  const save = (facts: HouseholdFactsInput) =>
    saveHouseholdFacts(test.database, { ...facts, ages: [...facts.ages] }, memberId);

  it("saves the facts with the ZIP code's state and time zone, and finishes the wizard's step 4", async () => {
    expect(await householdTimeZone(test.database)).toBeUndefined();

    const result = await save(NEW_YORK);

    expect(result).toMatchObject({
      saved: { ...NEW_YORK, ages: [41, 39, 8, 0], state: "NY", timeZone: "America/New_York" },
    });
    expect(await readHouseholdFacts(test.database)).toMatchObject({
      zipCode: "10001",
      ages: [41, 39, 8, 0],
      rentOrOwn: "rent",
    });
    expect(await householdTimeZone(test.database)).toBe("America/New_York");
    expect((await readSetupSteps(test.database)).get("household facts")).toBe("done");
  });

  it("refuses an unknown ZIP code and saves nothing", async () => {
    expect(await save({ ...NEW_YORK, zipCode: "00000" })).toBe("unknown zip code");

    expect(await readHouseholdFacts(test.database)).toBeUndefined();
    expect((await readSetupSteps(test.database)).get("household facts")).toBeUndefined();
  });

  it("changes the Household time zone at once on an edit", async () => {
    await save(NEW_YORK);
    await save({ ...NEW_YORK, zipCode: "85001" });

    expect(await householdTimeZone(test.database)).toBe("America/Phoenix");
  });

  it("fires the facts-edited hook on each edit, with the facts before and after", async () => {
    await save(NEW_YORK);
    expect(edits).toEqual([]);

    await save({ ...NEW_YORK, ages: [41, 39, 8, 1] });
    await save({ ...NEW_YORK, ages: [41, 39, 8, 1], rentOrOwn: "own" });

    expect(edits.map(({ previous, facts }) => [previous.ages, facts.rentOrOwn])).toEqual([
      [[41, 39, 8, 0], "rent"],
      [[41, 39, 8, 1], "own"],
    ]);
    expect(edits.every((edit) => edit.memberId === memberId)).toBe(true);
  });

  it("does not fire the hook for a save that changes nothing", async () => {
    await save(NEW_YORK);
    await save(NEW_YORK);

    expect(edits).toEqual([]);
  });

  it("still saves the edit when a listener fails", async () => {
    const stop = onHouseholdFactsEdited(() => {
      throw new Error("A listener that fails");
    });
    try {
      await save(NEW_YORK);
      await save({ ...NEW_YORK, rentOrOwn: "own" });
    } finally {
      stop();
    }

    expect((await readHouseholdFacts(test.database))?.rentOrOwn).toBe("own");
    expect(edits).toHaveLength(1);
  });

  it("logs a failed listener with its error's name only, never its message or stack", async () => {
    const madeUp = `made-up-${crypto.randomUUID()}`;
    const written: string[] = [];
    const capture = (chunk: string | Uint8Array) => written.push(String(chunk)) > 0;
    vi.spyOn(process.stdout, "write").mockImplementation(capture);
    vi.spyOn(process.stderr, "write").mockImplementation(capture);
    const stop = onHouseholdFactsEdited(() => {
      throw new RangeError(`A listener that fails with ${madeUp}`);
    });
    try {
      await save(NEW_YORK);
      await save({ ...NEW_YORK, rentOrOwn: "own" });
    } finally {
      stop();
      vi.restoreAllMocks();
    }

    const failed = written
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === "A Household facts listener failed");
    expect(failed).toEqual([expect.objectContaining({ level: "error", errorName: "RangeError" })]);
    expect(written.join("")).not.toContain(madeUp);
    expect(written.join("")).not.toContain("facts.test.ts");
  });
});
