import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMigrations,
  closeDatabase,
  type Database,
  openDatabase,
  scheduledTasks,
} from "../db/index.ts";
import { registerSecretValue } from "../log.ts";
import { newMasterKeyHex } from "../secrets/testing.ts";
import { daily, Job, type RunningJobs, type ScheduledTask, startJob, startJobs } from "./index.ts";
import {
  finishSlowJob,
  jobRuns,
  SampleJob,
  SlowJob,
  sampleTask,
  TEST_JOB_LIST,
  TickJob,
  waitFor,
} from "./testing.ts";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));
const FAILING_JOB_PROBE = fileURLToPath(new URL("./failing-job-probe.ts", import.meta.url));

// A fake secret value, made for this test run.
const fakeSecret = () => `fake-secret-${newMasterKeyHex().slice(0, 24)}`;

// A job class the test job list does not export.
class UnlistedJob extends Job {
  override async run(): Promise<void> {}
}

describe("background jobs", () => {
  let dir: string;
  let database: Database;
  let jobs: RunningJobs | undefined;
  // The fake clock and the Household time zone the scheduler reads.
  let now: Date;
  let timeZone: string | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "fft-jobs-"));
    database = await openDatabase(`file:${join(dir, "app.db")}`);
    await applyMigrations(database, MIGRATIONS);
    now = new Date("2026-11-03T01:00:00Z");
    timeZone = undefined;
    jobRuns.length = 0;
  });

  afterEach(async () => {
    vi.useRealTimers();
    finishSlowJob();
    await jobs?.stop();
    jobs = undefined;
    closeDatabase(database);
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(tasks: ScheduledTask[] = [sampleTask], jobList = TEST_JOB_LIST) {
    jobs = await startJobs({
      jobsDb: join(dir, "jobs.db"),
      jobList,
      tasks,
      database,
      now: () => now,
      timeZone: async () => timeZone,
    });
    return jobs;
  }

  async function storedTask(name: string) {
    const rows = await database.select().from(scheduledTasks);
    return rows.find((row) => row.name === name);
  }

  it("starts each task whose next run time has passed, and Sidequest runs its job", async () => {
    const later: ScheduledTask = { name: "later", schedule: daily("05:00"), job: SampleJob };
    const running = await start([sampleTask, later]);
    expect(await running.tick()).toEqual([]);
    expect(await storedTask("sample")).toEqual({
      name: "sample",
      lastRunAt: null,
      nextRunAt: new Date("2026-11-03T03:00:00Z"),
      timeZone: "UTC",
    });

    now = new Date("2026-11-03T03:00:30Z");

    expect(await running.tick()).toEqual(["sample"]);
    await waitFor(() => jobRuns.length > 0);
    expect(jobRuns).toEqual(["SampleJob"]);
    expect(await storedTask("sample")).toMatchObject({
      lastRunAt: now,
      nextRunAt: new Date("2026-11-04T03:00:00Z"),
    });
    expect((await storedTask("later"))?.nextRunAt).toEqual(new Date("2026-11-03T05:00:00Z"));
  });

  it("runs a task that missed three runs once", async () => {
    const running = await start();
    await running.tick();

    // The app was off through 03:00 on Nov 3, 4, and 5.
    now = new Date("2026-11-05T09:00:00Z");

    expect(await running.tick()).toEqual(["sample"]);
    expect(await running.tick()).toEqual([]);
    expect((await storedTask("sample"))?.nextRunAt).toEqual(new Date("2026-11-06T03:00:00Z"));
    await waitFor(() => jobRuns.length > 0);
    expect(jobRuns).toEqual(["SampleJob"]);
  });

  it("moves the next run when the Household time zone changes", async () => {
    const running = await start();
    await running.tick();
    expect(await storedTask("sample")).toMatchObject({
      nextRunAt: new Date("2026-11-03T03:00:00Z"),
      timeZone: "UTC",
    });

    timeZone = "America/New_York";
    expect(await running.tick()).toEqual([]);

    // 03:00 in New York, on Eastern Standard Time.
    expect(await storedTask("sample")).toMatchObject({
      nextRunAt: new Date("2026-11-03T08:00:00Z"),
      timeZone: "America/New_York",
    });
  });

  it("runs the tick in the tick job, which Sidequest runs", async () => {
    await start();
    await jobs?.tick();
    now = new Date("2026-11-03T03:00:30Z");

    await startJob(TickJob, []);

    await waitFor(() => jobRuns.length > 0);
    expect(jobRuns).toEqual(["SampleJob"]);
  });

  it("holds a job started with a start time until then, and runs one without at once", async () => {
    await start();

    await startJob(SampleJob, ["in an hour"], { at: new Date(Date.now() + 60 * 60 * 1000) });
    await startJob(SampleJob, ["at once"]);

    await waitFor(() => jobRuns.length > 0);
    expect(jobRuns).toEqual(["at once"]);
  });

  it("runs one job at a time", async () => {
    await start();
    await startJob(SlowJob, []);
    await startJob(SampleJob, ["next"]);
    await waitFor(() => jobRuns.length > 0);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(jobRuns).toEqual(["SlowJob"]);

    finishSlowJob();
    await waitFor(() => jobRuns.length > 1);
    expect(jobRuns).toEqual(["SlowJob", "next"]);
  });

  it("opens no port, so Sidequest's dashboard stays off", async () => {
    const listening = () =>
      process.getActiveResourcesInfo().filter((kind) => kind === "TCPServerWrap").length;
    const before = listening();

    await start();

    expect(listening()).toBe(before);
    await expect(fetch("http://127.0.0.1:8678/")).rejects.toThrow();
  });

  it("refuses a job list without this module's TickJob", async () => {
    const elsewhere = new URL("./schedule.ts", import.meta.url).href;

    await expect(start([], elsewhere)).rejects.toThrow("does not export this app's TickJob");
  });

  it("refuses a job class that overrides perform, which would skip the error guard", () => {
    class OverridingJob extends Job {
      override async run(): Promise<void> {}
      override async perform(...args: Parameters<Job["perform"]>): ReturnType<Job["perform"]> {
        return super.perform(...args);
      }
    }
    class Below extends OverridingJob {}

    expect(() => new OverridingJob()).toThrow("OverridingJob overrides perform");
    expect(() => new Below()).toThrow("Below overrides perform");
    expect(() => new UnlistedJob()).not.toThrow();
  });

  it("refuses a job class that sets perform as a class field, in the job list and in startJob", async () => {
    // A job list that exports such a class, and the class itself, from a test module.
    const { FieldPerformJob } = await import("./field-perform-list.ts");
    const fieldList = new URL("./field-perform-list.ts", import.meta.url).href;

    await expect(start([], fieldList)).rejects.toThrow("FieldPerformJob overrides perform");

    await start();
    await expect(startJob(FieldPerformJob, [])).rejects.toThrow("overrides perform");
  });

  it("ignores what run returns, so a job cannot hand Sidequest its own error", async () => {
    const secret = fakeSecret();
    class ReturningJob extends Job {
      override async run(): Promise<void> {
        // A job that tries to fail itself with a raw error, around the guard.
        return this.fail(new Error(secret)) as unknown as undefined;
      }
    }

    const result = await new ReturningJob().perform();

    expect(result).toMatchObject({ type: "completed" });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("refuses a task or a job that is not in the job list", async () => {
    const unlisted: ScheduledTask = {
      name: "unlisted",
      schedule: daily("03:00"),
      job: UnlistedJob,
    };
    await expect(start([unlisted])).rejects.toThrow("UnlistedJob, which is not in the job list");

    await start();
    await expect(startJob(UnlistedJob, [])).rejects.toThrow("UnlistedJob is not in the job list");
  });

  it("runs one tick at a time, so two ticks at once start a due task once", async () => {
    const running = await start();
    await running.tick();
    now = new Date("2026-11-03T03:00:30Z");

    const started = await Promise.all([running.tick(), running.tick()]);

    expect(started).toEqual([["sample"], []]);
  });

  it("starts the tick job at the start of every minute", async () => {
    // Sidequest's cron timer reads Date. Here Date runs 1.5 s before 03:59, which starts a minute
    // but no hour.
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-11-03T03:58:58.500Z"));
    const running = await start();
    await running.tick();
    now = new Date("2026-11-03T03:00:30Z");

    // No test code starts the tick job, so only its schedule runs the sample task.
    await waitFor(() => jobRuns.length > 0);

    expect(jobRuns).toEqual(["SampleJob"]);
  });

  it("refuses a job argument that holds a registered secret value", async () => {
    const secret = fakeSecret();
    registerSecretValue(secret);
    await start();

    for (const argument of [
      secret,
      `https://bank.invalid/?token=${secret}`,
      { connection: "c1", nested: [{ value: secret }] },
      { [secret]: "a name that is a secret" },
    ]) {
      await expect(startJob(SampleJob, [argument])).rejects.toThrow(
        "An argument to SampleJob holds a secret",
      );
    }
    await startJob(SampleJob, ["no secret here"]);
    await waitFor(() => jobRuns.length > 0);
    expect(jobRuns).toEqual(["no secret here"]);
  });

  it("keeps a job's thrown error, and its arguments, out of Sidequest's log and jobs.db", async () => {
    const secret = fakeSecret();
    const argument = `argument-${newMasterKeyHex().slice(0, 12)}`;

    // A child process, so the test sees what Sidequest itself writes to stdout.
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [FAILING_JOB_PROBE, dir, secret, argument],
      { env: { ...process.env, NODE_ENV: "production" }, timeout: 30_000 },
    );
    const lines = stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const jobsDbFiles = readdirSync(dir)
      .filter((name) => name.startsWith("jobs.db"))
      .map((name) => readFileSync(join(dir, name)).toString("latin1"));

    // The job ran, threw, and Sidequest stored the error of its first attempt.
    const probe = lines.at(-1);
    expect(probe?.probe).toBe("done");
    const [stored] = (probe?.errors ?? []) as object[];
    expect(stored).toBeDefined();
    expect(jobsDbFiles.length).toBeGreaterThan(0);

    // The secret is nowhere Sidequest writes.
    for (const text of [stdout, stderr, ...jobsDbFiles]) expect(text).not.toContain(secret);

    // Sidequest got only the fixed error: its own fields, and the attempt fields Sidequest adds.
    expect(stored).toMatchObject({ name: "Error", message: "FailingJob failed." });
    expect(Object.keys(stored ?? {}).sort()).toEqual([
      "attempt",
      "attempt_by",
      "attempted_at",
      "level",
      "message",
      "name",
      "stack",
    ]);
    // The app's log reported the failure, and refused the secret.
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: "A job failed", job: "FailingJob" }),
    );
    // Sidequest logs at warn and above. Below warn it logs each job's arguments.
    const sidequestLines = lines.filter((line) => line.label === "Sidequest");
    expect(sidequestLines.length).toBeGreaterThan(0);
    for (const line of sidequestLines) expect(["warn", "error"]).toContain(line.level);
    expect(stdout).not.toContain(argument);
  });
});
