// What the Benchmark route answers. This file imports nothing, so the web app's type check can
// follow it through api.ts.

// What a Category's Benchmark does (spec 05, Which Categories have a Benchmark).
export type BenchmarkRoleView = "drafts" | "drafts shared" | "context" | "none";

export type CategoryBenchmarkView = {
  category: string;
  role: BenchmarkRoleView;
  // B(c), in whole cents per month, or null when the Category has no Benchmark. Groceries and
  // Superstores both show B_GS.
  amount: number | null;
  // B(c) ÷ Steady Income, or null with no Benchmark or with Steady Income at $0.
  share: number | null;
};

export type BenchmarksView = {
  // The label every Benchmark the app shows must carry while the snapshot is the sample, such as
  // "Sample numbers, not real data", or null for the real snapshot.
  notice: string | null;
  // Steady Income, in whole cents per month, or null until the wizard records the Household facts.
  steadyIncome: number | null;
  // The CE income column the shares come from, or null until the Household facts are recorded.
  ceColumn: { table: "size and income" | "income"; label: string } | null;
  // Every Category, in list order. Empty until the Household facts are recorded.
  categories: CategoryBenchmarkView[];
};

export type BenchmarkRoutes = {
  benchmarks(): Promise<BenchmarksView>;
};
