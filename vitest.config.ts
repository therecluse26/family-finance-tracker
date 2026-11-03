import { defineConfig } from "vitest/config";

// Sidequest's files. Sidequest imports each job class from the job list itself. Run outside Vitest,
// that import would load a second copy of src/jobs, without the running app's state. Vitest
// therefore runs Sidequest's files too, so both imports share one copy, as they do in the app.
const SIDEQUEST = /\/node_modules\/(?:sidequest|@sidequest\/[^/]+)\//;

// Vite's warning for each Sidequest file it runs: Sidequest's published source maps name source
// files it does not publish. Only this warning is dropped.
const SIDEQUEST_SOURCE_MAP =
  /^Sourcemap for "[^"]*\/node_modules\/(?:sidequest|@sidequest\/[^/]+)\/[^"]*" points to missing source files$/;

export default defineConfig({
  plugins: [
    {
      name: "drop-sidequest-source-map-warnings",
      // Vitest sets its own logger, so this wraps the logger Vite ends up with.
      configResolved(config) {
        const warnOnce = config.logger.warnOnce;
        config.logger.warnOnce = (message, options) => {
          if (!SIDEQUEST_SOURCE_MAP.test(message)) warnOnce(message, options);
        };
      },
    },
  ],
  test: {
    include: ["{src,scripts}/**/*.test.{ts,tsx}"],
    environment: "node",
    server: { deps: { inline: [SIDEQUEST] } },
  },
});
