import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { browserNotices } from "./scripts/browser-notices.ts";
import type { Security } from "./src/server/security-mode.ts";

const webRoot = fileURLToPath(new URL("./src/web", import.meta.url));
const serverApp = fileURLToPath(new URL("./src/server/app.ts", import.meta.url));
const securityMode = fileURLToPath(new URL("./src/server/security-mode.ts", import.meta.url));
const DEV_PORT = 5173;

// In `pnpm dev`, Vite serves the web app and hands /api and /healthz to the Hono app.
function honoDevServer(): Plugin {
  return {
    name: "hono-dev-server",
    apply: "serve",
    configureServer(server) {
      let security: Promise<Security> | undefined;
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0] ?? "";
        if (path !== "/healthz" && path !== "/api" && !path.startsWith("/api/")) return next();
        security ??= server
          .ssrLoadModule(securityMode)
          .then((mod: Partial<typeof import("./src/server/security-mode.ts")>) => {
            if (!mod.loadSecurity) throw new Error("security-mode.ts has no loadSecurity export.");
            return mod.loadSecurity({
              APP_URL: process.env.APP_URL ?? `http://localhost:${DEV_PORT}`,
              TRUSTED_PROXIES: process.env.TRUSTED_PROXIES,
            });
          });
        Promise.all([server.ssrLoadModule(serverApp), security])
          .then(([mod, loaded]: [Partial<typeof import("./src/server/app.ts")>, Security]) => {
            if (!mod.createApp) throw new Error("src/server/app.ts has no createApp export.");
            return getRequestListener(mod.createApp(webRoot, loaded).fetch)(req, res);
          })
          .catch(next);
      });
    },
  };
}

export default defineConfig({
  root: webRoot,
  oxc: { jsx: { runtime: "automatic" } },
  plugins: [tailwindcss(), honoDevServer(), browserNotices()],
  // The dev APP_URL names this port, so Vite must not move to another.
  server: { port: DEV_PORT, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
    // The SPA has no server components, so React Router's "use client" lines mean nothing here.
    rolldownOptions: { checks: { moduleLevelDirective: false } },
  },
});
