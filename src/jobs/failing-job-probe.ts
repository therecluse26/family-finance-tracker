// Run by jobs.test.ts with plain node, since Vitest hides what Sidequest itself writes to stdout.
// It registers a secret value, runs a job that throws an error holding it, waits for the job's
// first attempt to end, and prints the job's stored errors.
//   node src/jobs/failing-job-probe.ts <dir> <secret> <argument>
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Sidequest } from "sidequest";
import { applyMigrations, closeDatabase, openDatabase } from "../db/index.ts";
import { registerSecretValue } from "../log.ts";
import { startJob, startJobs } from "./sidequest.ts";
import { FailingJob, failWith, TEST_JOB_LIST } from "./testing.ts";

const [dir = "", secret = "", argument = ""] = process.argv.slice(2);
registerSecretValue(secret);

// The error an HTTP client throws: the request body, with its credentials, rides on the error.
const error = new Error(`The upstream call failed for ${secret}`);
Object.assign(error, { config: { data: JSON.stringify({ client_id: "fake", secret }) } });
failWith(error);

const database = await openDatabase(`file:${join(dir, "app.db")}`);
await applyMigrations(database, fileURLToPath(new URL("../../drizzle", import.meta.url)));
const jobs = await startJobs({
  jobsDb: join(dir, "jobs.db"),
  jobList: TEST_JOB_LIST,
  tasks: [],
  database,
});
await startJob(FailingJob, [argument]);

const failed = async () => {
  const [job] = (await Sidequest.job.list()).filter((data) => data.class === "FailingJob");
  return job?.errors?.length ? job : undefined;
};
const deadline = Date.now() + 10_000;
let job = await failed();
while (job === undefined && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  job = await failed();
}
await jobs.stop();
closeDatabase(database);
process.stdout.write(`${JSON.stringify({ probe: "done", errors: job?.errors ?? null })}\n`);
