import { HISTORY_NOW } from "./history.ts";

// The history's clock. The history ends at HISTORY_NOW, but each route and job reads the time with
// `new Date()` or `Date.now()`. On the real clock a case runs days or years after the history, so
// its Recurring charges look overdue. A case runs with Date moved back to HISTORY_NOW: it starts
// there and moves at the real rate. Only Date moves; performance.now, process.cpuUsage, and timers
// stay real, so each timing is real.

const RealDate = globalThis.Date;

// The real time, for what must not move with the history, such as the build cache's file ages.
export const realNow = (): number => RealDate.now();

// Moves Date to the history's clock until the returned function puts the real one back.
export function useHistoryClock(): () => void {
  const offset = HISTORY_NOW().getTime() - RealDate.now();
  const now = () => RealDate.now() + offset;
  globalThis.Date = new Proxy(RealDate, {
    construct: (target, args, newTarget) =>
      Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget),
    apply: () => new RealDate(now()).toString(),
    get: (target, key, receiver) => (key === "now" ? now : Reflect.get(target, key, receiver)),
  });
  return () => {
    globalThis.Date = RealDate;
  };
}
