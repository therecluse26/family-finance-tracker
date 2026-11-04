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
  BLS_API,
  CPI_FETCH_CAP,
  CPI_FETCH_DAY,
  CPI_SERIES,
  CPI_STOPPED,
  type CpiFetchFailure,
  CpiFetchJob,
  type CpiFetchOptions,
  type CpiSeries,
  type CpiValue,
  cpiNow,
  cpiPeriodLabel,
  cpiRound,
  lastCpiFetch,
  startCpiFetch,
} from "./cpi.ts";
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
