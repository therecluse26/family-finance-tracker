import { useEffect, useRef, useState } from "react";

// Reading a view again on a timer while work runs on the server, such as a new Connection's first
// sync or a history load, so the page shows its progress with no reload. Every poll has a cap and
// an end state: it stops when a read says the work is over, or after `maxReads` reads, and then
// says it gave up. It never reads twice at once: the next read waits for the one before.

export type PollPlan = { everyMs: number; maxReads: number };

// "polling" while it reads, "ended" once a read said the work is over, "gave up" at the cap.
export type PollState = "polling" | "ended" | "gave up";

// Calls `read` every `plan.everyMs`, first after one wait. `read` answers true while the work still
// runs. A read that throws counts as a read, so a server that stops answering hits the cap too.
// Returns a stop function: after it, no read starts, and the answer of one in flight is ignored.
export function startPolling(
  read: () => Promise<boolean>,
  plan: PollPlan,
  onEnd: (state: Exclude<PollState, "polling">) => void,
): () => void {
  let stopped = false;
  let reads = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const next = () => {
    timer = setTimeout(async () => {
      reads += 1;
      let running: boolean;
      try {
        running = await read();
      } catch {
        running = true;
      }
      if (stopped) return;
      if (!running) {
        stopped = true;
        onEnd("ended");
      } else if (reads >= plan.maxReads) {
        stopped = true;
        onEnd("gave up");
      } else {
        next();
      }
    }, plan.everyMs);
  };
  next();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

// Polls while `active` is true, and stops when the page unmounts. A new `round`, such as the next
// bank linked, starts a fresh count after a give-up. `read` may change on each render: the latest
// one is used.
export function usePolling(
  active: boolean,
  read: () => Promise<boolean>,
  plan: PollPlan,
  round = 0,
): PollState {
  const [state, setState] = useState<PollState>("ended");
  const latest = useRef(read);
  latest.current = read;
  const { everyMs, maxReads } = plan;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new round restarts the count.
  useEffect(() => {
    if (!active) {
      setState("ended");
      return;
    }
    setState("polling");
    return startPolling(() => latest.current(), { everyMs, maxReads }, setState);
  }, [active, everyMs, maxReads, round]);

  return state;
}
