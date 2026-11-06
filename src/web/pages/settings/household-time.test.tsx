import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToString } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { householdZoneSaved, readHouseholdZone } from "../../household-zone.ts";
import { lastCheckText } from "../../master-key.ts";
import { UpdateLines } from "./About.tsx";
import { todayHere } from "./Ai.tsx";
import { BackupLines } from "./BackupsAndData.tsx";
import { syncNowLine } from "./Banks.tsx";
import { cpiFetchText } from "./DataSources.tsx";
import { InviteLine, LinkToCopy, MembersLists } from "./Members.tsx";
import { addedOn } from "./MyLogin.tsx";

// Settings shows every date and time in the Household time zone, not the browser's (spec 10, Data
// conventions), and each field for a fresh code takes a backup code, which holds letters (spec 09,
// Members). The browser here is in Kiribati, 14 hours ahead of UTC; the Household is in New York.

const ZONE = "America/New_York";
const FAR = "Pacific/Kiritimati";
// 11:30 PM on Nov 9 in New York is already 6:30 PM on Nov 10 in Kiribati.
const LATE = "2026-11-10T04:30:00.000Z";
const NOW = new Date("2026-11-10T04:45:00.000Z");

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");

describe("Settings with the browser in another time zone", () => {
  const before = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = FAR;
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(FAR);
  });

  afterAll(() => {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  });

  it("shows the CPI fetch date near midnight on the Household's day", () => {
    expect(cpiFetchText(LATE, ZONE, NOW)).toBe("The app last fetched the CPI from BLS on Nov 9.");
  });

  it("shows when a skipped bank can sync again in Household time", () => {
    const skipped = {
      connectionId: "c1",
      bankName: "First Fake Bank",
      outcome: "skipped",
    } as const;
    expect(syncNowLine({ ...skipped, canSyncAt: LATE }, ZONE, NOW)).toBe(
      "First Fake Bank synced a short while ago. It can sync again at 11:30 PM.",
    );
  });

  it("shows the last backup and the last Master key check in Household time", () => {
    const html = renderToString(
      <BackupLines
        backups={{ folder: "/backups", readable: true, lastBackupAt: LATE, files: 1, bytes: 512 }}
        zone={ZONE}
        now={NOW}
      />,
    );
    expect(text(html)).toContain("Last backup: Nov 9 at 11:30 PM.");
    expect(lastCheckText({ memberName: "Bob", at: LATE, matched: true }, ZONE, NOW)).toBe(
      "Bob last checked it on Nov 9 at 11:30 PM. It matched.",
    );
  });

  it("shows the Update check's day, invite and reset link days, and passkey days on the Household's day", () => {
    const check = { on: true, checkedAt: LATE, update: null, lastFailure: null };
    expect(text(renderToString(<UpdateLines check={check} zone={ZONE} now={NOW} />))).toContain(
      "The app last checked on Nov 9.",
    );
    const invite = { id: "i1", madeBy: "Alice", createdAt: LATE, expiresAt: LATE };
    expect(
      text(renderToString(<InviteLine invite={invite} zone={ZONE} onCancelled={() => {}} />)),
    ).toContain("Made Nov 9 by Alice. Works until Nov 9.");
    const made = { link: "http://nas.local:8080/join#token=t", expiresAt: LATE };
    expect(text(renderToString(<LinkToCopy made={made} zone={ZONE} />))).toContain(
      "It works until Nov 9.",
    );
    expect(addedOn(LATE, ZONE, NOW)).toBe("Nov 9");
    expect(todayHere(NOW, ZONE)).toBe("2026-11-09");
  });
});

describe("the Household time zone read", () => {
  const asked: string[] = [];

  function answer(timeZone: string | null): void {
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      asked.push(
        new URL(String(input instanceof Request ? input.url : input), "http://x").pathname,
      );
      return Response.json({ timeZone });
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    asked.length = 0;
  });

  it("reads the zone alone, never the Household facts, once for every part that asks at once", async () => {
    // Before the wizard's step 4, dates are UTC's, and the next page asks again.
    answer(null);
    expect(await readHouseholdZone()).toBe("UTC");
    answer(ZONE);
    expect(await Promise.all([readHouseholdZone(), readHouseholdZone()])).toEqual([ZONE, ZONE]);
    expect(asked).toEqual(["/api/household/time-zone", "/api/household/time-zone"]);

    // Once known, it is read no more. Saving the facts hands over a new one.
    expect(await readHouseholdZone()).toBe(ZONE);
    householdZoneSaved("Pacific/Honolulu");
    expect(await readHouseholdZone()).toBe("Pacific/Honolulu");
    expect(asked).toHaveLength(2);
  });
});

describe("the Settings source", () => {
  const folder = join(import.meta.dirname);
  const pages = readdirSync(folder)
    .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
    .map((name) => ({ name, source: readFileSync(join(folder, name), "utf8") }));
  const masterKey = readFileSync(join(folder, "../../master-key.ts"), "utf8");

  it("never reads the browser's time zone or the Household facts for a time zone", () => {
    expect(pages.length).toBeGreaterThan(10);
    for (const { name, source } of [...pages, { name: "master-key.ts", source: masterKey }]) {
      expect(source, name).not.toMatch(
        /resolvedOptions\(\)|browserZone|toLocale(?:Date|Time)?String\(\)/,
      );
    }
    // Only Settings, Household reads the Household facts, which hold the ZIP code and ages.
    const factReaders = pages.filter(({ source }) => /api\.household\s*\.\$get/.test(source));
    expect(factReaders.map(({ name }) => name)).toEqual(["Household.tsx"]);
  });

  it("gives each field for a fresh code or a backup code the full keyboard, and no digits-only pattern", () => {
    const codeFields = pages.flatMap(({ name, source }) =>
      [...source.matchAll(/<(?:input|TextField|Field)\b[^>]*?one-time-code[^>]*?\/>/gs)].map(
        (match) => ({ name, field: match[0] }),
      ),
    );
    expect(codeFields.length).toBeGreaterThan(5);
    for (const { name, field } of codeFields) {
      expect(field, name).not.toMatch(/inputMode="numeric"|pattern=/);
      if (field.startsWith("<input")) expect(field, name).toContain('inputMode="text"');
    }
  });

  it("lets the invite link's code field take a backup code with letters", () => {
    const html = renderToString(
      <MembersLists
        members={[]}
        invites={[]}
        zone={ZONE}
        onChange={() => {}}
        onRemoved={() => {}}
      />,
    );
    const field = html.match(/<input[^>]*one-time-code[^>]*>/)?.[0] ?? "";
    expect(field).toContain('inputMode="text"');
    expect(field).not.toMatch(/pattern=|inputMode="numeric"/);
  });
});
