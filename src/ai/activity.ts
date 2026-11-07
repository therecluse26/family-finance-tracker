import type { AiActivityFeed, AiActivityUse, AiActivityView } from "../redo/work-view.ts";
import { isBackground, type ModelUse } from "./ai-view.ts";

// The background AI work running now, for the live AI status (spec 08, Live AI status). It lives in
// this process's memory only: nothing goes to app.db, and a restart forgets it. It holds use names,
// step names, the run's kind, and counts, and nothing else. Every change goes at once to each
// watcher, such as each open GET /api/ai/activity/stream.

type Watcher = { changed: (view: AiActivityView) => void; ended: () => void };

type Run = AiActivityView["run"];

let run: Run = null;
// Each background use with a call in progress, and how many calls it has. A Map keeps the order in
// which each use's first call started.
const calls = new Map<AiActivityUse, number>();
const watchers = new Set<Watcher>();

function view(): AiActivityView {
  return {
    run: run === null ? null : { ...run },
    uses: [...calls].map(([use, count]) => ({ use, calls: count })),
  };
}

// A watcher that throws is dropped, so one broken stream never stops the others or the work.
function tell(): void {
  if (watchers.size === 0) return;
  const now = view();
  for (const watcher of [...watchers]) {
    try {
      watcher.changed(now);
    } catch {
      watchers.delete(watcher);
    }
  }
}

// Whether the live AI status shows a call of this use: every background use does.
export function isActivityUse(use: ModelUse): use is AiActivityUse {
  return isBackground(use);
}

// A call of a background use starts. Returns the function that ends it, which the caller runs in a
// `finally`, so a throw never leaves the use shown as working. Running the end twice ends it once.
export function startAiActivity(use: AiActivityUse): () => void {
  calls.set(use, (calls.get(use) ?? 0) + 1);
  tell();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const left = (calls.get(use) ?? 1) - 1;
    if (left > 0) calls.set(use, left);
    else calls.delete(use);
    tell();
  };
}

// The run of the redo of no-AI work now, or null when none runs. The redo module sets it at each
// change of its press, its step, and its end.
export function showRunActivity(next: Run): void {
  const same =
    next === null || run === null ? next === run : next.kind === run.kind && next.step === run.step;
  if (same) return;
  run = next === null ? null : { ...next };
  tell();
}

// How many watchers are open now.
export function aiActivityWatchers(): number {
  return watchers.size;
}

export const aiActivity: AiActivityFeed = {
  now: view,
  watch(changed, ended) {
    const watcher = { changed, ended };
    watchers.add(watcher);
    return () => {
      watchers.delete(watcher);
    };
  },
  // The app stops: every watcher ends, so no open stream holds up the server's close.
  stop() {
    const open = [...watchers];
    watchers.clear();
    for (const watcher of open) {
      try {
        watcher.ended();
      } catch {
        // The watcher is gone already.
      }
    }
  },
};
