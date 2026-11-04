import { benchmarkSnapshot } from "../src/benchmarks/index.ts";
import { releaseProblem } from "./benchmark-snapshot.ts";

// The release check for the Benchmark snapshot: it fails while the shipped snapshot is the sample
// built from the made-up fixture files, or fails its schema. The release runs it before it
// publishes an image. Run it with `pnpm check:benchmarks`.

let problem: string | undefined;
try {
  problem = releaseProblem(benchmarkSnapshot());
} catch (error) {
  problem = `The Benchmark snapshot fails its schema: ${error instanceof Error ? error.message : error}`;
}
if (problem !== undefined) {
  console.error(problem);
  process.exit(1);
}
console.log("The Benchmark snapshot was built from the real source files.");
