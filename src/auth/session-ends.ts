// Spec 09, Signing in: a session that ends gets no more data. Each place in this process that ends
// a session tells the watchers at once, such as each open stream of the live AI status (spec 08,
// Live AI status), which then checks its own session and ends with it. The signal names no session:
// a watcher checks its own, so a path that ends many sessions, or a Member's, needs no list.

const watchers = new Set<() => void>();

// One or more sessions ended now.
export function tellSessionsEnded(): void {
  for (const changed of [...watchers]) {
    try {
      changed();
    } catch {
      // One broken watcher never stops the others, or the sign-out.
    }
  }
}

// Calls `changed` each time a session ends. Returns the function that stops it.
export function watchSessionEnds(changed: () => void): () => void {
  const watcher = () => changed();
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

// How many watchers are open now.
export function sessionEndWatchers(): number {
  return watchers.size;
}
