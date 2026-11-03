import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Plugin } from "vite";
import {
  BUNDLER_PACKAGES,
  type InstalledPackage,
  isAllowed,
  licenseOf,
  listInstalled,
  type ReviewedRecord,
  ROOT,
  readReviewed,
  SHIPPED_LICENSES,
} from "./licenses.ts";
import { noticesFor, renderNotices } from "./notices.ts";

export const BROWSER_NOTICES = "third-party-notices.txt";

// The package folder that holds a module, from the last node_modules in its path.
export function packageDirOf(id: string): string | undefined {
  const path = id.replace(/\\/g, "/").replace(/[?#].*$/, "");
  const marker = "/node_modules/";
  const at = path.lastIndexOf(marker);
  if (at === -1) return undefined;
  const parts = path.slice(at + marker.length).split("/");
  const nameParts = parts[0]?.startsWith("@") ? 2 : 1;
  if (parts.length <= nameParts) return undefined;
  return path.slice(0, at + marker.length) + parts.slice(0, nameParts).join("/");
}

// The bundler writes its own helpers into the bundle as virtual modules, such as
// "\0rolldown/runtime.js". The first path segment names the package they come from.
export function virtualModuleOwner(id: string): string | undefined {
  if (!id.startsWith("\0")) return undefined;
  return /^\0((?:@[^/]+\/)?[^/@][^/]*)\//.exec(id)?.[1];
}

const CSS_IMPORT = /@(?:import|plugin|reference|config)\s+(?:url\(\s*)?["']([^"']+)["']/g;
const NOT_A_PACKAGE = /^(?:\.|\/|[a-z][a-z\d+.-]*:)/i;

export function cssImports(css: string): { packages: string[]; files: string[] } {
  const specifiers = [...css.matchAll(CSS_IMPORT)].map((match) => match[1] as string);
  return {
    packages: specifiers.filter((specifier) => !NOT_A_PACKAGE.test(specifier)),
    files: specifiers.filter((specifier) => specifier.startsWith(".")),
  };
}

// Tailwind reads the CSS it imports itself, outside Vite's module graph, so the packages
// those files import are found by reading the app's own CSS files.
function ownCssFiles(ids: Iterable<string>): string[] {
  const queue = [...ids]
    .filter((id) => !id.startsWith("\0") && packageDirOf(id) === undefined)
    .map((id) => id.replace(/[?#].*$/, ""))
    .filter((path) => path.endsWith(".css"));
  const seen = new Set<string>();
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    for (const file of cssImports(readFileSync(path, "utf8")).files) {
      queue.push(resolve(dirname(path), file));
    }
  }
  return [...seen];
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// Finds the package behind each module in the browser bundle. Each package must be in the
// "dependencies" tree or on BUNDLER_PACKAGES, and pass the shipped allowlist. A module that
// is neither in appDir nor in a package fails.
export function bundledPackages(
  ids: Iterable<string>,
  input: {
    appDir: string;
    shipped: readonly InstalledPackage[];
    installed: readonly InstalledPackage[];
    reviewed: readonly ReviewedRecord[];
  },
): { packages: InstalledPackage[]; problems: string[] } {
  const byDir = (packages: readonly InstalledPackage[]) =>
    new Map(packages.map((pkg) => [realpathOr(pkg.path), pkg]));
  const shipped = byDir(input.shipped);
  const bundlers = input.installed.filter((pkg) => BUNDLER_PACKAGES.includes(pkg.name));
  const bundlerDirs = byDir(bundlers);
  const appDir = `${realpathOr(input.appDir)}/`;
  const bundled = new Map<string, InstalledPackage>();
  const problems: string[] = [];

  for (const id of ids) {
    if (id.startsWith("\0")) {
      const owner = virtualModuleOwner(id);
      const owners = bundlers.filter((pkg) => pkg.name === owner);
      if (owners[0] !== undefined && owners.length === 1) {
        bundled.set(owners[0].path, owners[0]);
      } else {
        problems.push(
          `The virtual module ${JSON.stringify(id)} is in the browser bundle, but it comes from none of ${BUNDLER_PACKAGES.join(", ")}.`,
        );
      }
      continue;
    }
    const dir = packageDirOf(id);
    if (dir === undefined) {
      const path = id.replace(/[?#].*$/, "");
      if (!isAbsolute(path) || !realpathOr(path).startsWith(appDir)) {
        problems.push(
          `${id} is in the browser bundle, but it is neither the app's code nor a package.`,
        );
      }
      continue;
    }
    const pkg = shipped.get(realpathOr(dir)) ?? bundlerDirs.get(realpathOr(dir));
    if (pkg) bundled.set(pkg.path, pkg);
    else problems.push(`${dir} is in the browser bundle, so it must be in "dependencies".`);
  }

  for (const pkg of bundled.values()) {
    const license = licenseOf(pkg, input.reviewed);
    if (license === undefined || !isAllowed(license, SHIPPED_LICENSES)) {
      problems.push(
        `${pkg.name}@${pkg.version} is in the browser bundle, and the shipped allowlist does not allow "${license ?? pkg.declared ?? "no license field"}".`,
      );
    }
  }
  return { packages: [...bundled.values()], problems };
}

// Writes third-party-notices.txt for the packages whose code is in the browser bundle.
export function browserNotices(): Plugin {
  let root = "";
  return {
    name: "browser-notices",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    async generateBundle(_options, bundle) {
      // The whole module graph, not only the output chunks: Rolldown can inline a module's
      // constants and drop the module, and its package still counts.
      const ids = new Set(this.getModuleIds());
      for (const file of Object.values(bundle)) {
        if (file.type === "chunk") for (const id of Object.keys(file.modules)) ids.add(id);
        else for (const name of file.originalFileNames) ids.add(resolve(root, name));
      }
      for (const css of ownCssFiles(ids)) {
        for (const specifier of cssImports(readFileSync(css, "utf8")).packages) {
          const resolved = await this.resolve(specifier, css);
          if (!resolved) this.error(`${css} imports "${specifier}", which does not resolve.`);
          ids.add(resolved.id);
        }
      }

      const reviewed = readReviewed();
      const { packages, problems } = bundledPackages(ids, {
        appDir: join(ROOT, "src"),
        shipped: listInstalled("prod"),
        installed: listInstalled("all"),
        reviewed,
      });
      const notices = noticesFor(packages, reviewed);
      problems.push(...notices.problems);
      if (problems.length > 0) this.error(problems.join("\n"));

      this.emitFile({
        type: "asset",
        fileName: BROWSER_NOTICES,
        source: renderNotices(
          "Third-party notices for the Family Finance Tracker web app",
          notices.notices,
        ),
      });
    },
  };
}
