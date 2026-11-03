import { describe, expect, it } from "vitest";
import {
  bundledPackages,
  cssImports,
  packageDirOf,
  virtualModuleOwner,
} from "./browser-notices.ts";
import type { InstalledPackage } from "./licenses.ts";

const NM = "/fixture/node_modules/.pnpm";

function installed(name: string, version: string, declared = "MIT"): InstalledPackage {
  const dir = `${NM}/${name.replace("/", "+")}@${version}/node_modules/${name}`;
  return { name, version, declared, path: dir };
}

describe("bundledPackages", () => {
  const react = installed("react", "19.3.1");
  const gplTwo = installed("gpl-two", "2.0.0", "GPL-2.0-only");
  const vite = installed("vite", "8.3.5");
  const rolldown = installed("rolldown", "1.2.16");
  const devOnly = installed("dev-only", "1.0.0");
  const input = {
    appDir: "/app/src",
    shipped: [react, gplTwo],
    installed: [react, gplTwo, vite, rolldown, devOnly],
    reviewed: [],
  };
  const helpers = ["\0rolldown/runtime.js", "\0vite/modulepreload-polyfill.js"];

  it("finds each shipped package once, and the bundler packages that wrote its helpers", () => {
    const { packages, problems } = bundledPackages(
      [
        `${react.path}/cjs/react.production.js`,
        `${react.path}/index.js`,
        ...helpers,
        `${vite.path}/dist/client/env.mjs`,
        "/app/src/web/main.tsx",
        "/app/src/web/styles.css?direct",
      ],
      input,
    );

    expect(problems).toEqual([]);
    expect(packages.map((pkg) => pkg.name)).toEqual(["react", "rolldown", "vite"]);
  });

  it("judges the bundler packages by the shipped allowlist", () => {
    const ccRolldown = installed("rolldown", "1.2.16", "CC-BY-4.0");
    const { problems } = bundledPackages(helpers, {
      ...input,
      installed: [react, vite, ccRolldown],
    });

    expect(problems).toEqual([
      'rolldown@1.2.16 is in the browser bundle, and the shipped allowlist does not allow "CC-BY-4.0".',
    ]);
  });

  it("fails a bundled package that is outside the dependencies tree", () => {
    const { problems } = bundledPackages([`${devOnly.path}/index.js`], input);

    expect(problems).toEqual([
      `${devOnly.path} is in the browser bundle, so it must be in "dependencies".`,
    ]);
  });

  it("fails a helper from an installed build tool that is not a bundler package", () => {
    const { problems } = bundledPackages(["\0dev-only/helper.js"], input);

    expect(problems).toEqual([
      'The virtual module "\\u0000dev-only/helper.js" is in the browser bundle, but it comes from none of vite, rolldown.',
    ]);
  });

  it("fails a bundled package whose license the shipped allowlist does not allow", () => {
    const { problems } = bundledPackages([`${gplTwo.path}/index.js`], input);

    expect(problems).toEqual([
      'gpl-two@2.0.0 is in the browser bundle, and the shipped allowlist does not allow "GPL-2.0-only".',
    ]);
  });

  it("fails a virtual module that no bundler package owns", () => {
    const { problems } = bundledPackages(["\0virtual:pwa-register"], input);

    expect(problems).toEqual([
      'The virtual module "\\u0000virtual:pwa-register" is in the browser bundle, but it comes from none of vite, rolldown.',
    ]);
  });

  it.each(["/elsewhere/vendor/lib.js", "virtual:no-null-byte"])(
    "fails %s, which is neither the app's code nor a package",
    (id) => {
      expect(bundledPackages([id], input).problems).toEqual([
        `${id} is in the browser bundle, but it is neither the app's code nor a package.`,
      ]);
    },
  );
});

describe("packageDirOf", () => {
  it.each([
    [
      "/app/node_modules/.pnpm/react-dom@19.3.1_react@19.3.1/node_modules/react-dom/cjs/react-dom.production.js",
      "/app/node_modules/.pnpm/react-dom@19.3.1_react@19.3.1/node_modules/react-dom",
    ],
    [
      "/app/node_modules/.pnpm/@hono+node-server@2.1.5/node_modules/@hono/node-server/dist/index.mjs",
      "/app/node_modules/.pnpm/@hono+node-server@2.1.5/node_modules/@hono/node-server",
    ],
    [
      "/app/node_modules/a/node_modules/b/index.js?commonjs-proxy",
      "/app/node_modules/a/node_modules/b",
    ],
    ["C:\\app\\node_modules\\hono\\dist\\client\\index.js", "C:/app/node_modules/hono"],
  ])("finds the package folder of %s", (id, dir) => {
    expect(packageDirOf(id)).toBe(dir);
  });

  it.each(["/app/src/web/main.tsx", "\0rolldown/runtime.js", "/app/node_modules/.pnpm"])(
    "finds no package for %s",
    (id) => {
      expect(packageDirOf(id)).toBeUndefined();
    },
  );
});

describe("virtualModuleOwner", () => {
  it.each([
    ["\0rolldown/runtime.js", "rolldown"],
    ["\0vite/modulepreload-polyfill.js", "vite"],
    ["\0@scope/plugin/helper.js", "@scope/plugin"],
    ["\0virtual:pwa-register", undefined],
    ["/app/src/web/main.tsx", undefined],
  ])("gives %j to %s", (id, owner) => {
    expect(virtualModuleOwner(id)).toBe(owner);
  });
});

describe("cssImports", () => {
  it("separates package imports from the app's own files and URLs", () => {
    const css = [
      '@import "tailwindcss";',
      "@import 'tailwindcss/theme.css' layer(theme);",
      '@plugin "@tailwindcss/typography";',
      '@import "./fonts.css";',
      '@import url("https://fonts.example.com/inter.css");',
      '@import "/absolute.css";',
      "body { color: black; }",
    ].join("\n");

    expect(cssImports(css)).toEqual({
      packages: ["tailwindcss", "tailwindcss/theme.css", "@tailwindcss/typography"],
      files: ["./fonts.css"],
    });
  });
});
