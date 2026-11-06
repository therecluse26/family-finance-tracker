import {
  type FinishSetupItem,
  type SetupProgressView,
  SKIPPABLE_SETUP_STEPS,
  type SkippableSetupStep,
} from "../server/setup-views.ts";
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

// The setup code survives a reload until the first Member exists (spec 12, Step 1). It stays in
// this tab's sessionStorage only, exactly as the server took it, and is checked again before use.
const SETUP_CODE_KEY = "fft-setup-code";
// The longest code the server takes.
const MAX_SETUP_CODE_LENGTH = 64;

type CodeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// This tab's sessionStorage, or undefined where the browser blocks it. The window is read through
// globalThis, because server tests also load this file.
function tabStorage(): CodeStorage | undefined {
  try {
    return (globalThis as { window?: { sessionStorage: CodeStorage } }).window?.sessionStorage;
  } catch {
    return undefined;
  }
}

export function savedSetupCode(storage = tabStorage()): string | undefined {
  try {
    const code = storage?.getItem(SETUP_CODE_KEY);
    if (typeof code !== "string" || code === "" || code.length > MAX_SETUP_CODE_LENGTH) {
      return undefined;
    }
    return code;
  } catch {
    return undefined;
  }
}

export function saveSetupCode(code: string, storage = tabStorage()): void {
  try {
    if (code !== "" && code.length <= MAX_SETUP_CODE_LENGTH) storage?.setItem(SETUP_CODE_KEY, code);
  } catch {
    // Without storage, a reload asks for the code again.
  }
}

// A refusal that means the kept code can never work: a code with the wrong form (400), a wrong code
// (401), or a Member already made (403). After too many wrong codes (429) or a server error, the
// code may still be right, so the page keeps it.
export function setupCodeRefused(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

export function forgetSetupCode(storage = tabStorage()): void {
  try {
    storage?.removeItem(SETUP_CODE_KEY);
  } catch {
    // Nothing was kept.
  }
}

// After steps 1 to 4, the first Member's next visit opens step 5, Banks, until it is done or
// skipped, then step 6, until they open the dashboard from it (spec 12, Order and resume rules).
// The server answers next: null to every other Member, so a Member who joined by invite never sees
// the wizard.
export async function fetchSetupProgress(): Promise<SetupProgressView | undefined> {
  const res = await api.setup.progress.$get();
  if (!res.ok) return undefined;
  return ((await res.json()) as { progress: SetupProgressView }).progress;
}

// The wizard steps the first Member skipped, as the server records them. The step bar shows each one
// as not done, after Skip for now and after a reload alike.
export function skippedWizardSteps(progress: SetupProgressView | undefined): SkippableSetupStep[] {
  return SKIPPABLE_SETUP_STEPS.filter((step) => progress?.steps[step] === "skipped");
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

// Where each "Finish setup" item's work is done: its Settings section (spec 07, Header and status
// lines, "Finish setup").
export const FINISH_SETUP_LINKS: Record<FinishSetupItem, { label: string; path: string }> = {
  banks: { label: "Link your banks", path: "/settings/banks" },
  ai: { label: "Set up AI", path: "/settings/ai" },
  alerts: { label: "Set up email Alerts and send a test email", path: "/settings/alerts" },
  "invite members": { label: "Invite Members", path: "/settings/members" },
};
