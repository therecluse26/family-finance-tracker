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

// One page's poll, which the page tells after each render or read whether work runs. It starts a
// fresh poll when `active`, the plan or the `round` changes, and leaves a poll alone otherwise, so a
// poll that gave up stays given up until a new round, such as the next bank linked. `stop` ends the
// poll when the page leaves; a later `update` starts again, as React's Strict Mode mounts twice.
export type Poller = {
  update(active: boolean, plan: PollPlan, round?: number): void;
  stop(): void;
};

export function createPoller(
  read: () => Promise<boolean>,
  onState: (state: PollState) => void,
): Poller {
  let shown: string | undefined;
  let stopRun: (() => void) | undefined;
  const halt = () => {
    stopRun?.();
    stopRun = undefined;
  };
  return {
    update(active, plan, round = 0) {
      const key = [active, plan.everyMs, plan.maxReads, round].join("|");
      if (key === shown) return;
      shown = key;
      halt();
      if (!active) return onState("ended");
      onState("polling");
      stopRun = startPolling(read, plan, onState);
    },
    stop() {
      halt();
      shown = undefined;
    },
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
  const [poller] = useState(() => createPoller(() => latest.current(), setState));

  useEffect(() => poller.update(active, plan, round));
  useEffect(() => () => poller.stop(), [poller]);

  return state;
}

// Which answer may show when reads overlap, such as a poll's read and a Member action's read of the
// same list. Each read takes a place with `begin` before it asks. Its answer shows only when no
// later read's answer has shown yet, so an older answer that lands last is dropped.
export function answerOrder(): { begin(): () => boolean } {
  let started = 0;
  let shown = 0;
  return {
    begin() {
      started += 1;
      const mine = started;
      return () => {
        if (mine < shown) return false;
        shown = mine;
        return true;
      };
    },
  };
}
