// The benchmarks module's interface (spec 05, Benchmarks). Other modules import from here.
export {
  B_GS_CE_LINES,
  BENCHMARK_ROLES,
  type BenchmarkRole,
  CE_LINE_MAP,
  CE_LINES,
  type CeLine,
  type CeLineChoice,
  ceLinesOf,
} from "./ce-lines.ts";
export {
  type BenchmarkSnapshot,
  type BenchmarkSource,
  benchmarkNotice,
  benchmarkSnapshot,
  benchmarkSnapshotSchema,
  type CeTable,
  type FoodPlan,
  SAMPLE_NOTICE,
} from "./snapshot.ts";
