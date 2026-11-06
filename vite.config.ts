import type { ServerResponse } from "node:http";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { browserNotices } from "./scripts/browser-notices.ts";
import { type DevAppHolder, devAppHolder } from "./scripts/dev-app-holder.ts";
import type { DevEnv } from "./src/server/dev-app.ts";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));
const webRoot = fileURLToPath(new URL("./src/web", import.meta.url));
const devApp = fileURLToPath(new URL("./src/server/dev-app.ts", import.meta.url));
const DEV_PORT = 5173;

type DevAppModule = Partial<typeof import("./src/server/dev-app.ts")>;
type DevApp = Awaited<ReturnType<NonNullable<DevAppModule["createDevApp"]>>>;

// Sidequest's packages. Sidequest imports each job class from the job list itself. Run outside
// Vite, that import would load a second copy of src/jobs, without the dev app's state. Vite
// therefore runs Sidequest's files too, so both imports share one copy, as they do in the built app.
const SIDEQUEST = ["sidequest", /^@sidequest\//];

// Vite's warning for each Sidequest file it runs: Sidequest's published source maps name source
// files it does not publish. Only this warning is dropped.
const SIDEQUEST_SOURCE_MAP =
  /^Sourcemap for "[^"]*\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:sidequest|@sidequest\/[^/]+)\/[^"]*" points to missing source files$/;

// The dev app's settings, read from process.env once in each `pnpm dev`. The Master key then leaves
// process.env, so a restart, even Vite's own after an edit to this file, reuses this copy. Each
// start gets a fresh object, because loadMasterKey deletes FFT_MASTER_KEY from the one it reads.
const DEV_ENV = Symbol.for("fft.devEnv");
function devEnv(): DevEnv {
  const held = globalThis as { [DEV_ENV]?: DevEnv };
  if (!held[DEV_ENV]) {
    held[DEV_ENV] = {
      APP_URL: process.env.APP_URL ?? `http://localhost:${DEV_PORT}`,
      TRUSTED_PROXIES: process.env.TRUSTED_PROXIES,
      FFT_MASTER_KEY_FILE: process.env.FFT_MASTER_KEY_FILE,
      FFT_MASTER_KEY: process.env.FFT_MASTER_KEY,
    };
    delete process.env.FFT_MASTER_KEY;
  }
  return { ...held[DEV_ENV] };
}

// In `pnpm dev`, Vite serves the web app and hands /api and /healthz to the Hono app, which runs
// on its own app.db and jobs.db in .dev/, with the services `pnpm start` runs. With no Master key
// set, it makes .dev/master.key. After an edit to a file the dev app runs, the dev app stops and
// starts again (scripts/dev-app-holder.ts). When Vite closes, on `q`, SIGTERM or Ctrl-C, the app
// stops its jobs and closes app.db.
function honoDevServer(): Plugin {
  let holder: DevAppHolder<DevApp> | undefined;
  return {
    name: "hono-dev-server",
    apply: "serve",
    configResolved(config) {
      const warnOnce = config.logger.warnOnce;
      config.logger.warnOnce = (message, options) => {
        if (!SIDEQUEST_SOURCE_MAP.test(message)) warnOnce(message, options);
      };
    },
    async closeServer() {
      await holder?.shutdown();
    },
    // A file the dev app runs has modules in Vite's SSR graph. Vite drops them now, so the next
    // job would import new, empty copies: the dev app starts again on them.
    hotUpdate({ file, modules }) {
      if (this.environment.name !== "ssr" || modules.length === 0 || !holder) return;
      const logger = this.environment.logger;
      const running = holder;
      logger.info(`Restarting the dev app: ${relative(repoRoot, file)} changed.`, {
        timestamp: true,
      });
      void running.restart().then(() =>
        running.current().catch((error: unknown) => {
          logger.error(
            `The dev app could not start again: ${error instanceof Error ? error.message : String(error)} Save a fix to try again.`,
          );
        }),
      );
    },
    configureServer(server) {
      const started = devAppHolder(() =>
        server.ssrLoadModule(devApp).then((mod: DevAppModule) => {
          if (!mod.createDevApp) throw new Error("dev-app.ts has no createDevApp export.");
          return mod.createDevApp(webRoot, devEnv());
        }),
      );
      holder = started;
      // Vite closes on SIGTERM, but not on Ctrl-C. Without this, Node would exit at once and leave
      // a running job claimed in .dev/jobs.db. A second Ctrl-C exits at once.
      const stopOnCtrlC = () => {
        void server.close().finally(() => process.exit(0));
      };
      process.once("SIGINT", stopOnCtrlC);
      server.httpServer?.once("close", () => process.off("SIGINT", stopOnCtrlC));
      // The API starts with the server, so a new dev Master key and the setup link show at once.
      // When it cannot start, such as with a bad .dev/master.key, `pnpm dev` prints the reason
      // once, with no stack, and stops.
      server.httpServer?.once("listening", () => {
        started.current().catch(async (error: unknown) => {
          server.config.logger.error(error instanceof Error ? error.message : String(error));
          await server.close();
          process.exit(1);
        });
      });
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0] ?? "";
        if (path !== "/healthz" && path !== "/api" && !path.startsWith("/api/")) return next();
        started
          .current()
          .then(
            (loaded) => {
              if (loaded) return getRequestListener(loaded.app.fetch)(req, res);
              unavailable(res, "The dev app has stopped.");
            },
            // The terminal already holds the reason, so no request prints it again.
            () => unavailable(res, "The dev app could not start. The reason is in the terminal."),
          )
          .catch(next);
      });
    },
  };
}

function unavailable(res: ServerResponse, message: string): void {
  res.statusCode = 503;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(`${message}\n`);
}

// The installable app and the service worker for web push (spec 01, What the product is; spec 06,
// Recipients and channels). sw.ts is built on its own, with no precache list: the worker imports
// no package and caches nothing. The page registers it itself, over HTTPS only (src/web/install.ts).
const installableApp = VitePWA({
  strategies: "injectManifest",
  srcDir: ".",
  filename: "sw.ts",
  injectRegister: false,
  injectManifest: { injectionPoint: undefined, rollupFormat: "iife" },
  manifest: {
    name: "Family Finance Tracker",
    short_name: "Finances",
    description: "The Household's money, Budgets, and Alerts.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#1f6f5c",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  },
});

export default defineConfig({
  root: webRoot,
  oxc: { jsx: { runtime: "automatic" } },
  plugins: [tailwindcss(), honoDevServer(), browserNotices(), installableApp],
  ssr: { noExternal: SIDEQUEST },
  // The dev APP_URL names this port, so Vite must not move to another.
  server: { port: DEV_PORT, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
    // The SPA has no server components, so React Router's "use client" lines mean nothing here.
    rolldownOptions: { checks: { moduleLevelDirective: false } },
  },
});
