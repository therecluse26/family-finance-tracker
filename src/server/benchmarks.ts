import { benchmarkNotice, categoryBenchmarks } from "../benchmarks/index.ts";
import type { Database } from "../db/index.ts";
import type { BenchmarkRoutes } from "./benchmarks-views.ts";

// The Benchmark route (spec 05, Benchmarks): each Category's Benchmark and role, through the
// benchmarks module. The Household facts it reads never reach the answer.
export function benchmarkRoutes(database: Database): BenchmarkRoutes {
  return {
    async benchmarks() {
      const notice = benchmarkNotice() ?? null;
      const computed = await categoryBenchmarks(database);
      if (computed === undefined) {
        return { notice, steadyIncome: null, ceColumn: null, categories: [] };
      }
      return {
        notice,
        steadyIncome: computed.income,
        ceColumn: computed.ceColumn,
        categories: computed.categories.map(({ category, role, amount, share }) => ({
          category,
          role,
          amount,
          share,
        })),
      };
    },
  };
}
