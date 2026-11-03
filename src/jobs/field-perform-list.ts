// A job list for jobs.test.ts that holds a job class setting perform as a class field. A field is
// set on each instance, so the prototype check alone misses it. The jobs module must refuse it.
import { Job } from "./job.ts";

export { TickJob } from "./sidequest.ts";

export class FieldPerformJob extends Job {
  override async run(): Promise<void> {}
  override perform = async () => this.complete(undefined);
}
