import { useEffect, useState } from "react";
import { api } from "./api.ts";

// The Household time zone, in which Settings shows every date and time (spec 10, Data
// conventions: "Screens show it in the Household time zone"). The app reads it once, from a light
// read that holds nothing else, never from GET /api/household, which holds the ZIP code and ages.
// Saving the Household facts hands it the new one.

// Until the wizard's step 4 sets the Household time zone, the app's dates are UTC's, as on the
// server. That answer is not kept, so the next page reads again.
const BEFORE_HOUSEHOLD_FACTS = "UTC";

let known: string | undefined;
// One read for every part of a page that asks at once.
let reading: Promise<string | undefined> | undefined;

// The Household facts were saved, maybe with a new ZIP code in another time zone.
export function householdZoneSaved(zone: string): void {
  known = zone;
}

// The Household time zone, or undefined when the server did not answer.
export function readHouseholdZone(): Promise<string | undefined> {
  if (known !== undefined) return Promise.resolve(known);
  reading ??= (async () => {
    try {
      const res = await api.household["time-zone"].$get();
      if (!res.ok) return undefined;
      const { timeZone } = (await res.json()) as { timeZone: string | null };
      if (timeZone === null) return BEFORE_HOUSEHOLD_FACTS;
      known = timeZone;
      return timeZone;
    } catch {
      return undefined;
    }
  })().finally(() => {
    reading = undefined;
  });
  return reading;
}

// The Household time zone once it has loaded. A page shows its dates and times only then.
export function useHouseholdZone(): string | undefined {
  const [zone, setZone] = useState<string | undefined>(known);
  useEffect(() => {
    let open = true;
    void readHouseholdZone().then((read) => {
      if (open && read !== undefined) setZone(read);
    });
    return () => {
      open = false;
    };
  }, []);
  return zone;
}
