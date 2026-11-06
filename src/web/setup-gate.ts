import type { OptionalSetupStep, SetupProgressView } from "../server/setup-views.ts";
import { api } from "./api.ts";

// Until the first-run wizard's steps 1 to 4 are done, every page leads to the wizard (spec 12,
// The first-run wizard). GET /api/setup says which step comes next, with no session.

export type SetupState = { next: string | null; wizard: boolean };

export async function fetchSetupState(): Promise<SetupState> {
  const res = await fetch("/api/setup", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`/api/setup answered ${res.status}.`);
  return (await res.json()) as SetupState;
}

// Whether a page leads to the wizard. Steps 3 and 4 need the first Member signed in, so once the
// first Member exists, the sign-in page stays open to them.
export function leadsToWizard(state: SetupState, page: "app" | "sign-in"): boolean {
  if (!state.wizard) return false;
  return page === "app" || state.next === "setup link";
}

// Opens the wizard when the page leads there. True when it did, so the page does nothing more.
export async function openWizardIfNeeded(
  navigate: (path: string, options: { replace: boolean }) => unknown,
  page: "app" | "sign-in",
  read: () => Promise<SetupState> = fetchSetupState,
): Promise<boolean> {
  if (!leadsToWizard(await read(), page)) return false;
  await navigate("/setup", { replace: true });
  return true;
}

// The setup code from the setup link's part after "#", such as "#code=7KQ2-M9XD-4TRF".
export function codeFromHash(hash: string): string | undefined {
  const code = new URLSearchParams(hash.replace(/^#/, "")).get("code")?.trim();
  return code === undefined || code === "" ? undefined : code;
}

// After steps 1 to 4, the first Member's next visit opens the first step neither done nor skipped,
// until they open the dashboard from step 9 (spec 12, Order and resume rules). The server answers
// next: null to every other Member, so a Member who joined by invite never sees the wizard.
export async function fetchSetupProgress(): Promise<SetupProgressView | undefined> {
  const res = await api.setup.progress.$get();
  if (!res.ok) return undefined;
  return ((await res.json()) as { progress: SetupProgressView }).progress;
}

// Opens the wizard's next step when the server names one. True when it did.
export async function resumeWizardIfNeeded(
  navigate: (path: string, options: { replace: boolean }) => unknown,
  read: () => Promise<SetupProgressView | undefined> = fetchSetupProgress,
): Promise<boolean> {
  if (((await read())?.next ?? null) === null) return false;
  await navigate("/setup", { replace: true });
  return true;
}

// Where each skipped step's work is done once the wizard is over: its Settings section (spec 07,
// Header and status lines, "Finish setup").
export const FINISH_SETUP_LINKS: Record<OptionalSetupStep, { label: string; path: string }> = {
  banks: { label: "Add your banks and Accounts", path: "/settings/banks" },
  ai: { label: "Set up AI", path: "/settings/ai" },
  alerts: { label: "Set up email Alerts and send a test email", path: "/settings/alerts" },
  "invite members": { label: "Invite Members", path: "/settings/members" },
};
