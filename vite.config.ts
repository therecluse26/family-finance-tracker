import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { browserNotices } from "./scripts/browser-notices.ts";

const webRoot = fileURLToPath(new URL("./src/web", import.meta.url));
const devApp = fileURLToPath(new URL("./src/server/dev-app.ts", import.meta.url));
const DEV_PORT = 5173;

type DevAppModule = Partial<typeof import("./src/server/dev-app.ts")>;
type HonoApp = Awaited<ReturnType<NonNullable<DevAppModule["createDevApp"]>>>;

// Sidequest's packages. Sidequest imports each job class from the job list itself. Run outside
// Vite, that import would load a second copy of src/jobs, without the dev app's state. Vite
// therefore runs Sidequest's files too, so both imports share one copy, as they do in the built app.
const SIDEQUEST = ["sidequest", /^@sidequest\//];

// Vite's warning for each Sidequest file it runs: Sidequest's published source maps name source
// files it does not publish. Only this warning is dropped.
const SIDEQUEST_SOURCE_MAP =
  /^Sourcemap for "[^"]*\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:sidequest|@sidequest\/[^/]+)\/[^"]*" points to missing source files$/;

// In `pnpm dev`, Vite serves the web app and hands /api and /healthz to the Hono app, which runs
// on its own app.db and jobs.db in .dev/, with the services `pnpm start` runs. With no Master key
// set, it makes .dev/master.key. When Vite closes, the app stops its jobs and closes app.db.
function honoDevServer(): Plugin {
  let app: Promise<HonoApp> | undefined;
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
      const running = app;
      app = undefined;
      await running?.then(
        (loaded) => loaded.close(),
        () => undefined,
      );
    },
    configureServer(server) {
      // The Master key leaves process.env here; loadMasterKey then deletes it from `env`.
      const startDevApp = () => {
        const env = {
          APP_URL: process.env.APP_URL ?? `http://localhost:${DEV_PORT}`,
          TRUSTED_PROXIES: process.env.TRUSTED_PROXIES,
          FFT_MASTER_KEY_FILE: process.env.FFT_MASTER_KEY_FILE,
          FFT_MASTER_KEY: process.env.FFT_MASTER_KEY,
        };
        delete process.env.FFT_MASTER_KEY;
        return server.ssrLoadModule(devApp).then((mod: DevAppModule) => {
          if (!mod.createDevApp) throw new Error("dev-app.ts has no createDevApp export.");
          return mod.createDevApp(webRoot, env);
        });
      };
      // The API starts with the server, so a new dev Master key and the setup link show at once.
      // When it cannot start, such as with a bad .dev/master.key, `pnpm dev` prints the reason
      // once, with no stack, and stops.
      server.httpServer?.once("listening", () => {
        app ??= startDevApp();
        app.catch(async (error: unknown) => {
          server.config.logger.error(error instanceof Error ? error.message : String(error));
          await server.close();
          process.exit(1);
        });
      });
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0] ?? "";
        if (path !== "/healthz" && path !== "/api" && !path.startsWith("/api/")) return next();
        app ??= startDevApp();
        app
          .then(
            (loaded) => getRequestListener(loaded.fetch)(req, res),
            // The terminal already holds the reason, so no request prints it again.
            () => {
              res.statusCode = 503;
              res.setHeader("Content-Type", "text/plain; charset=utf-8");
              res.end("The dev app could not start. The reason is in the terminal.\n");
            },
          )
          .catch(next);
      });
    },
  };
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
