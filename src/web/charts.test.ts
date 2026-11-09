import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "vite";
import { describe, expect, it } from "vitest";

// Every chart's words say its numbers (a caption or a list beside it), so no chart adds Recharts'
// keyboard and screen reader layer on top: a screen reader would read the numbers twice, and the
// layer's focus stop leads nowhere. Server rendering draws no chart at width 0, so this reads the
// source through Vite's own parser: comments do not count, and a chart imported under another
// name, or through `import * as`, is still a chart.

const WEB = fileURLToPath(new URL(".", import.meta.url));

function pages(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return pages(path);
    return entry.name.endsWith(".tsx") && !entry.name.includes(".test.") ? [path] : [];
  });
}

const isChart = (name: string) => name.endsWith("Chart");

// An ESTree node, as far as this test reads one.
type Node = { type: string; [field: string]: unknown };
const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";
const nameOf = (node: unknown): string | undefined =>
  isNode(node) && typeof node.name === "string" ? node.name : undefined;

function walk(node: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!isNode(node)) return;
  visit(node);
  for (const value of Object.values(node)) {
    if (typeof value === "object" && value !== null) walk(value, visit);
  }
}

// Each chart a file draws from recharts: its tag as written, and whether that opening tag sets
// accessibilityLayer={false}.
function rechartsCharts(path: string, source: string): { tag: string; off: boolean }[] {
  const { program, errors } = parseSync(path, source, { lang: "tsx" });
  expect(errors, path).toEqual([]);
  const local = new Set<string>();
  const namespaces = new Set<string>();
  walk(program, (node) => {
    if (node.type !== "ImportDeclaration" || (node.source as Node).value !== "recharts") return;
    for (const specifier of node.specifiers as Node[]) {
      const as = nameOf(specifier.local) ?? "";
      if (specifier.type === "ImportNamespaceSpecifier") namespaces.add(as);
      if (specifier.type === "ImportSpecifier" && isChart(nameOf(specifier.imported) ?? "")) {
        local.add(as);
      }
    }
  });

  const charts: { tag: string; off: boolean }[] = [];
  walk(program, (node) => {
    if (node.type !== "JSXOpeningElement" || !isNode(node.name)) return;
    const name = node.name;
    let tag: string | undefined;
    if (name.type === "JSXIdentifier" && local.has(nameOf(name) ?? "")) tag = nameOf(name);
    if (name.type === "JSXMemberExpression") {
      const object = nameOf(name.object) ?? "";
      const property = nameOf(name.property) ?? "";
      if (namespaces.has(object) && isChart(property)) tag = `${object}.${property}`;
    }
    if (tag === undefined) return;
    const off = (node.attributes as Node[]).some(
      (attribute) =>
        attribute.type === "JSXAttribute" &&
        nameOf(attribute.name) === "accessibilityLayer" &&
        isNode(attribute.value) &&
        attribute.value.type === "JSXExpressionContainer" &&
        isNode(attribute.value.expression) &&
        attribute.value.expression.type === "Literal" &&
        attribute.value.expression.value === false,
    );
    charts.push({ tag, off });
  });
  return charts;
}

describe("charts", () => {
  it("turns off Recharts' accessibility layer on every chart", () => {
    let charts = 0;
    for (const path of pages(WEB)) {
      for (const { tag, off } of rechartsCharts(path, readFileSync(path, "utf8"))) {
        charts += 1;
        expect(off, `${tag} in ${path}`).toBe(true);
      }
    }
    // The Dashboard's two, the balance chart, the pictures' two, and Spending over time and Cash
    // flow on the Reports page.
    expect(charts).toBeGreaterThanOrEqual(7);
  });

  it("does not count a comment, and finds a chart under another name", () => {
    const check = (source: string) => rechartsCharts("probe.tsx", source);
    expect(
      check(`import { Bar, BarChart } from "recharts";
        const a = <BarChart /* accessibilityLayer={false} */ data={rows}><Bar /></BarChart>;`),
    ).toEqual([{ tag: "BarChart", off: false }]);
    expect(
      check(`import { Bar } from "recharts";
        import { BarChart as Bars } from "recharts";
        const a = <Bars data={rows}><Bar /></Bars>;`),
    ).toEqual([{ tag: "Bars", off: false }]);
    expect(
      check(`import * as R from "recharts";
        const a = <R.LineChart accessibilityLayer={false} />;
        const b = <R.AreaChart accessibilityLayer />;`),
    ).toEqual([
      { tag: "R.LineChart", off: true },
      { tag: "R.AreaChart", off: false },
    ]);
    expect(
      check(`import { Pie, PieChart } from "recharts";
        const a = <PieChart accessibilityLayer={false}><Pie /></PieChart>;`),
    ).toEqual([{ tag: "PieChart", off: true }]);
  });
});
