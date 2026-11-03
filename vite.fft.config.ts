import { defineConfig } from "vite";
import { nodeBuild } from "./vite.server.config.ts";

// The `fft` command: dist/fft.js, which the image runs as /usr/local/bin/fft.
export default defineConfig(nodeBuild("./src/fft/main.ts", "fft.js"));
