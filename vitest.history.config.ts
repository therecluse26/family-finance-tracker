import { defineConfig } from "vitest/config";
import { TimingTableReporter } from "./src/large-history/reporter.ts";
import base from "./vitest.config.ts";

// `pnpm bench:history`: the large-history check (CLAUDE.md, K9). Each case file in
// src/large-history/cases/ is one test file. Files run one at a time, so no case slows another.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["src/large-history/cases/*.ts"],
    fileParallelism: false,
    reporters: ["default", new TimingTableReporter()],
  },
});
