import { join } from "node:path";
import type { FftIo } from "./io.ts";

// Test support: the parts of an fft command's input that `fft restore` uses, in a test's folder.
// The answers stand for the lines the self-hoster types, in order; each question asked is kept.

export type RestoreParts = Pick<FftIo, "backupFolders" | "jobsDbFile" | "runningLock" | "ask"> & {
  questions: string[];
};

export function restoreParts(dir: string, answers: string[] = []): RestoreParts {
  const questions: string[] = [];
  const left = [...answers];
  return {
    backupFolders: { mounted: join(dir, "backups-mount"), fallback: join(dir, "data", "backups") },
    jobsDbFile: join(dir, "data", "jobs.db"),
    runningLock: join(dir, "data", "app.lock"),
    questions,
    async ask(question) {
      questions.push(question);
      return left.shift() ?? "";
    },
  };
}
