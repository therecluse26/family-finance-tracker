import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HouseholdFactsView } from "../../../server/household-views.ts";
import { HouseholdFactsForm, HouseholdTimeZone } from "./Household.tsx";

// The Household facts form, as the wizard's step 4 and Settings, Household paint it.

const FACTS: HouseholdFactsView = {
  zipCode: "10001",
  ages: [41, 39, 8],
  rentOrOwn: "rent",
  state: "NY",
  timeZone: "America/New_York",
  updatedAt: "2026-11-03T12:00:00.000Z",
};

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/<!-- -->/g, "");

describe("the Household facts form", () => {
  it("asks for the ZIP code, each person's age, people without a login included, and rent or own", () => {
    const html = renderToString(
      <HouseholdFactsForm facts={null} submitLabel="Save and open the app" onSaved={() => {}} />,
    );

    expect(text(html)).toContain("ZIP code");
    expect(text(html)).toContain("Person 1, age in years");
    expect(text(html)).toContain("children and others without a login included");
    expect(text(html)).toContain("Rent");
    expect(text(html)).toContain("Own");
    expect(text(html)).toContain("The AI never receives them.");
    expect(text(html)).not.toMatch(/\bsex\b|\bgender\b|\bmale\b|\bfemale\b/i);
  });

  it("shows the saved facts for editing, one age per person", () => {
    const html = renderToString(
      <HouseholdFactsForm facts={FACTS} submitLabel="Save the facts" onSaved={() => {}} />,
    );

    expect(html).toContain('value="10001"');
    expect(text(html)).toContain("Person 3, age in years");
    expect(html).toMatch(/value="8"/);
    expect(html).toMatch(/type="radio"[^>]*checked=""/);
  });

  it("names the Household time zone and the extra run a change can bring", () => {
    const html = renderToString(<HouseholdTimeZone facts={FACTS} />);

    expect(text(html)).toContain("Household time zone: America/New_York");
    expect(text(html)).toContain("A daily task may then run one extra time that day.");
  });
});
