import { fileURLToPath } from "node:url";
import { log } from "../log.ts";
import { readPort } from "./port.ts";
import { loadSecurity } from "./security-mode.ts";
import { startServer } from "./server.ts";

const STOP_TIMEOUT_MS = 10_000;
// A Compose service gets a new IP address when its container is made again.
const PROXY_NAME_REFRESH_MS = 10_000;

async function main(): Promise<void> {
  const webRoot = fileURLToPath(new URL("web", import.meta.url));
  const port = readPort(process.env.PORT);
  const security = await loadSecurity(process.env);
  setInterval(() => void security.proxies.refresh(), PROXY_NAME_REFRESH_MS).unref();
  const server = await startServer({ port, webRoot, security });
  log.info("Listening", { port: server.port });

  const stop = (signal: NodeJS.Signals) => {
    log.info("Stopping", { signal });
    setTimeout(() => process.exit(0), STOP_TIMEOUT_MS).unref();
    server.close().then(
      () => process.exit(0),
      () => process.exit(0),
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch((error: unknown) => {
  log.error("The app could not start", { error });
  process.exit(1);
});
