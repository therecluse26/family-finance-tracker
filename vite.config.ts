import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const webRoot = fileURLToPath(new URL("./src/web", import.meta.url));
const serverApp = fileURLToPath(new URL("./src/server/app.ts", import.meta.url));

// In `pnpm dev`, Vite serves the web app and hands /api and /healthz to the Hono app.
function honoDevServer(): Plugin {
  return {
    name: "hono-dev-server",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0] ?? "";
        if (path !== "/healthz" && path !== "/api" && !path.startsWith("/api/")) return next();
        server
          .ssrLoadModule(serverApp)
          .then((mod: Partial<typeof import("./src/server/app.ts")>) => {
            if (!mod.createApp) throw new Error("src/server/app.ts has no createApp export.");
            return getRequestListener(mod.createApp(webRoot).fetch)(req, res);
          })
          .catch(next);
      });
    },
  };
}

export default defineConfig({
  root: webRoot,
  oxc: { jsx: { runtime: "automatic" } },
  plugins: [tailwindcss(), honoDevServer()],
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
    // The SPA has no server components, so React Router's "use client" lines mean nothing here.
    rolldownOptions: { checks: { moduleLevelDirective: false } },
  },
});
