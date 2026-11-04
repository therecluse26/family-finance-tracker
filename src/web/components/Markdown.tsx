import { Fragment, type ReactNode } from "react";

// A small Markdown renderer for the app's own documents, such as docs/data-sources.md, which the
// build bundles into the web app. It knows only what those documents use: headings, paragraphs,
// lists, tables, fenced code, bold, inline code, and links. It builds React elements, never HTML
// text, so nothing in a document runs as markup. A link opens only an https:// address.

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "code"; text: string };

const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^[-*]\s+(.*)$/;
const TABLE_RULE = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/;

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

// Splits a document into blocks. HTML comments, such as a generated table's markers, are left out.
export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const code: string[] = [];
      for (i++; i < lines.length && !(lines[i] ?? "").startsWith("```"); i++) {
        code.push(lines[i] ?? "");
      }
      blocks.push({ kind: "code", text: code.join("\n") });
      i++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      i++;
      continue;
    }
    if (line.trimStart().startsWith("|") && TABLE_RULE.test((lines[i + 1] ?? "").trim())) {
      const header = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && (lines[i] ?? "").trimStart().startsWith("|"); i++) {
        rows.push(cells(lines[i] ?? ""));
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const items: string[] = [];
      for (; i < lines.length && LIST_ITEM.test(lines[i] ?? ""); i++) {
        items.push(LIST_ITEM.exec(lines[i] ?? "")?.[1] ?? "");
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    const paragraph: string[] = [];
    for (; i < lines.length; i++) {
      const next = lines[i] ?? "";
      if (next.trim() === "" || HEADING.test(next) || LIST_ITEM.test(next)) break;
      if (next.startsWith("```") || next.trimStart().startsWith("|")) break;
      paragraph.push(next.trim());
    }
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
  }
  return blocks;
}

const INLINE = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

// Bold, inline code, and links in a line of text.
function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) nodes.push(text.slice(last, at));
    const [whole, bold, code, label, href] = match;
    if (bold !== undefined) {
      nodes.push(<strong key={at}>{inline(bold)}</strong>);
    } else if (code !== undefined) {
      nodes.push(
        <code key={at} className="rounded bg-gray-100 px-1">
          {code}
        </code>,
      );
    } else if (label !== undefined && href?.startsWith("https://")) {
      nodes.push(
        <a key={at} className="text-blue-700 underline" href={href} rel="noreferrer">
          {inline(label)}
        </a>,
      );
    } else {
      nodes.push(...inline(label ?? whole));
    }
    last = at + whole.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const HEADING_CLASS = ["text-xl font-semibold", "mt-6 text-lg font-semibold", "mt-4 font-semibold"];

// One block. `top` is the heading level a "#" gets.
function blockView(block: Block, top: number): ReactNode {
  switch (block.kind) {
    case "heading": {
      const Tag = `h${Math.min(block.level + top - 1, 6)}` as "h2";
      return (
        <Tag className={HEADING_CLASS[Math.min(block.level - 1, 2)]}>{inline(block.text)}</Tag>
      );
    }
    case "paragraph":
      return <p className="mt-2">{inline(block.text)}</p>;
    case "list":
      return (
        <ul className="mt-2 list-disc pl-6">
          {block.items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a bundled document never changes order.
            <li key={i}>{inline(item)}</li>
          ))}
        </ul>
      );
    case "table":
      return (
        <div className="mt-2 overflow-x-auto">
          <table className="text-left text-sm">
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a bundled document never changes order.
                  <th key={i} className="border-b px-2 py-1">
                    {inline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a bundled document never changes order.
                <tr key={r}>
                  {row.map((cell, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a bundled document never changes order.
                    <td key={i} className="border-b px-2 py-1 align-top">
                      {inline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "code":
      return (
        <pre className="mt-2 overflow-x-auto rounded bg-gray-100 p-2 text-sm">
          <code>{block.text}</code>
        </pre>
      );
  }
}

// A document's blocks. `topLevel` is the heading level its "#" gets, so the document fits under
// the page's own headings.
export function Markdown(props: { text: string; topLevel?: 2 | 3 }) {
  const top = props.topLevel ?? 2;
  return (
    <div>
      {parseMarkdown(props.text).map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a bundled document never changes order.
        <Fragment key={i}>{blockView(block, top)}</Fragment>
      ))}
    </div>
  );
}
