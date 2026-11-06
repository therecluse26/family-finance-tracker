import { calendarDateIn, dateLabel, timeLabel } from "../format.ts";
import { postJson } from "./requests.ts";

// The Master key's paste-back (wizard step 3) and "Check my master key" (Settings), which use the
// same check (spec 09, The Master key).

export type PasteResult = { matches: true } | { matches: false; error: string };

export const WRONG_KEY = "That is not the Master key. Check the copy you saved.";

// Sends a pasted key to one of the two routes. The key stays in the request body only.
export async function sendPastedKey(
  path: "/api/setup/master-key" | "/api/master-key/check",
  masterKey: string,
): Promise<PasteResult> {
  const res = await postJson(path, { masterKey });
  const body = (await res.json().catch(() => ({}))) as { matches?: unknown; error?: unknown };
  if (res.ok && body.matches === true) return { matches: true };
  if (res.ok) return { matches: false, error: WRONG_KEY };
  return {
    matches: false,
    error: typeof body.error === "string" ? body.error : "That did not work.",
  };
}

// The key in groups of 4, so a person can compare it with a saved copy.
export function grouped(masterKey: string): string {
  return masterKey.match(/.{1,4}/g)?.join(" ") ?? masterKey;
}

// "Bob checked it on Nov 3 at 9:05 AM, and it matched." Times show in `zone`, the Household time
// zone.
export function lastCheckText(
  check: { memberName: string | null; at: string; matched: boolean } | null,
  zone: string,
  now = new Date(),
): string {
  if (check === null) return "No one has checked the Master key yet.";
  const at = new Date(check.at);
  const when = `${dateLabel(calendarDateIn(at, zone), calendarDateIn(now, zone))} at ${timeLabel(at, zone)}`;
  const who = check.memberName ?? "A removed Member";
  return `${who} last checked it on ${when}. ${check.matched ? "It matched." : "It did not match."}`;
}
