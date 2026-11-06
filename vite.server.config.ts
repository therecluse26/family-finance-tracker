import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin, type UserConfig } from "vite";

// Packages stay in node_modules, so the LGPL job runner can be swapped in the image.
function isPackage(id: string): boolean {
  return !id.startsWith(".") && !id.startsWith("\0") && !isAbsolute(id);
}

function oneFileWithExternalPackages(): Plugin {
  return {
    name: "one-file-with-external-packages",
    generateBundle(_options, bundle) {
      const files = Object.values(bundle);
      if (files.length !== 1) {
        this.error(`The server build must be one file, not ${files.length}.`);
      }
      for (const file of files) {
        if (file.type !== "chunk") continue;
        const bundled = Object.keys(file.modules).filter((id) => id.includes("/node_modules/"));
        if (bundled.length > 0) {
          this.error(`The server build bundled package code: ${bundled.join(", ")}`);
        }
      }
    },
  };
}

// One Node entry point, built into one file in dist/. The `fft` command's build uses it too.
export function nodeBuild(entry: string, fileName: string): UserConfig {
  return {
    publicDir: false,
    plugins: [oneFileWithExternalPackages()],
    build: {
      ssr: fileURLToPath(new URL(entry, import.meta.url)),
      outDir: fileURLToPath(new URL("./dist", import.meta.url)),
      emptyOutDir: false,
      target: "node26",
      rolldownOptions: {
        external: isPackage,
        output: { entryFileNames: fileName },
      },
    },
  };
}

export default defineConfig(nodeBuild("./src/server/main.ts", "server.js"));
