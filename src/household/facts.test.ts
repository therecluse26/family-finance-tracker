import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loginTables, readSetupSteps } from "../db/index.ts";
import { newTestDatabase, type TestDatabase } from "../db/testing.ts";
import {
  type HouseholdFactsEdit,
  type HouseholdFactsInput,
  householdTimeZone,
  isNeverSentToAi,
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

  it("marks the facts as never sent to an AI provider, and keeps the mark out of JSON", async () => {
    const result = await save(NEW_YORK);
    const read = await readHouseholdFacts(test.database);

    expect(result !== "unknown zip code" && isNeverSentToAi(result.saved)).toBe(true);
    expect(isNeverSentToAi(read)).toBe(true);
    expect(isNeverSentToAi({ ...read })).toBe(false);
    expect(JSON.parse(JSON.stringify(read))).toMatchObject({ zipCode: "10001" });
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
    expect(
      edits.every((edit) => isNeverSentToAi(edit.facts) && isNeverSentToAi(edit.previous)),
    ).toBe(true);
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
});
