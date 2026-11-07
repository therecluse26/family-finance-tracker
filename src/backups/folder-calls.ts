// Time limits on the calls the app makes on the backup folder. A folder on a stale network mount
// can leave a call unanswered for good. Without a limit, the backup waits on it, every later backup
// waits behind it in the queue, and the stop waits on the startup check until the container is
// killed. With one, the backup fails, the daily backup's retry and its System notice follow, and
// the next backup tries again.

// How long one call on the backup folder may go without an answer, or a stream without a chunk.
// A NAS whose disks sleep can take 10 to 30 s to wake for the first call. The stop does not wait
// on this limit: it has time-outs of its own.
export const FOLDER_CALL_LIMIT_MS = 60_000;

// How many calls ran out of time and have not answered yet. A call that does not answer holds one
// of Node's few file-system threads until the mount answers again; with all of them held, every
// file read in the app waits. So while one waits, every new call fails at once and starts nothing
// on the folder, from any backup, retry, or status read, and at most one thread is held. The count
// drops when the call answers, which is when the mount is back.
let unanswered = 0;

export class FolderHungError extends Error {
  override name = "FolderHungError";
  constructor() {
    super("The backup folder did not answer in time.");
  }
}

// Runs one call on the backup folder within the time limit. A call that streams a file calls
// `progress` on each chunk, which starts the limit again, so only a stream that stalls runs out.
// `signal` aborts when the limit runs out, so a stream can close its files.
export type FolderCall = <T>(
  work: (progress: () => void, signal: AbortSignal) => Promise<T>,
) => Promise<T>;

// The calls of one backup, clean-up, or status read. After one call runs out of time, the folder
// counts as hung for the rest of them, and every later call fails at once, so a hung folder costs
// one limit, not one per call. The unanswered call goes on in the background, and its answer is
// dropped.
export function folderCalls(limitMs = FOLDER_CALL_LIMIT_MS): FolderCall {
  let hung = false;
  return <T>(work: (progress: () => void, signal: AbortSignal) => Promise<T>) => {
    if (hung || unanswered > 0) return Promise.reject(new FolderHungError());
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      let expired = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        settled = true;
        clearTimeout(timer);
      };
      const expire = () => {
        if (settled) return;
        settle();
        hung = true;
        expired = true;
        unanswered += 1;
        const error = new FolderHungError();
        controller.abort(error);
        reject(error);
      };
      const progress = () => {
        if (settled) return;
        clearTimeout(timer);
        timer = setTimeout(expire, limitMs);
      };
      progress();
      Promise.resolve()
        .then(() => work(progress, controller.signal))
        .then(
          (value) => {
            if (settled) return;
            settle();
            resolve(value);
          },
          (error: unknown) => {
            if (settled) return;
            settle();
            reject(error);
          },
        )
        .finally(() => {
          if (expired) unanswered -= 1;
        });
    });
  };
}

// For a call whose failure means "nothing there": undefined, except when the folder is hung, which
// is not the same as a missing file.
export function missingUnlessHung(error: unknown): undefined {
  if (error instanceof FolderHungError) throw error;
  return undefined;
}
