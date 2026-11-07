import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetupProgressView } from "../../server/setup-views.ts";
import { TextField } from "../components/Fields.tsx";
import { savedFirstMemberDraft, saveFirstMemberDraft, saveSetupCode } from "../setup-gate.ts";
import { CopiedLine, FirstMember, SetupLinkWorked, WizardHeader } from "./Setup.tsx";

// The setup page's header, as the browser first paints it (spec 12, Order and resume rules). The page
// renders it with the step on the screen, the furthest step reached, and the server's progress, which
// it reads after Skip for now and after a reload alike.

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// The words of each item in the list of steps, as a screen reader reads them (the text without its
// tags), and the "Step N of 6" line.
const stepWords = (html: string) => [
  text(html.match(/<p[^>]*>(.*?)<\/p>/)?.[1] ?? ""),
  ...[...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((item) =>
    (item[1] ?? "").replace(/<!-- -->/g, "").replace(/<[^>]+>/g, ""),
  ),
];

const progress = (banks: SetupProgressView["steps"]["banks"]): SetupProgressView => ({
  next: "finish",
  steps: { banks, ai: null, alerts: null, "invite members": null },
  finishSetup: ["ai", "alerts", "invite members"],
  connections: banks === "done" ? 1 : 0,
});

describe("the setup page's header", () => {
  it("shows a Banks step the server records as skipped as not done", () => {
    const html = renderToString(
      <WizardHeader shown="finish" reached="finish" progress={progress("skipped")} />,
    );

    expect(stepWords(html)).toEqual([
      "Step 6 of 6",
      "✓ Setup link",
      "✓ Your login",
      "✓ Master key",
      "✓ Household",
      "5. Banks (skipped)",
      "6. Finish",
    ]);
  });

  it("shows a Banks step done once a bank is linked, and before any progress is read", () => {
    expect(
      stepWords(
        renderToString(
          <WizardHeader shown="finish" reached="finish" progress={progress("done")} />,
        ),
      ).slice(4),
    ).toEqual(["✓ Household", "✓ Banks", "6. Finish"]);
    expect(
      stepWords(
        renderToString(<WizardHeader shown="banks" reached="banks" progress={undefined} />),
      ),
    ).toEqual([
      "Step 5 of 6",
      "✓ Setup link",
      "✓ Your login",
      "✓ Master key",
      "✓ Household",
      "5. Banks",
      "6. Finish",
    ]);
  });
});

// A tab's sessionStorage, as the browser gives it.
class TabStorage {
  readonly items = new Map<string, string>();
  getItem = (key: string) => this.items.get(key) ?? null;
  setItem = (key: string, value: string) => void this.items.set(key, value);
  removeItem = (key: string) => void this.items.delete(key);
}

// Every element of `type` in a component's answer, at any depth.
function elementsOf<P>(node: ReactNode, type: (props: P) => ReactNode): ReactElement<P>[] {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => elementsOf(child, type));
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  const own = node.type === type ? [node as unknown as ReactElement<P>] : [];
  return [...own, ...elementsOf(node.props.children, type)];
}

// Step 2 as the page renders it, keeping what it answered so a test can read each field.
let step2Answer: ReactNode;
function KeptStep2(props: Parameters<typeof FirstMember>[0]) {
  step2Answer = FirstMember(props);
  return step2Answer;
}

describe("step 2, Your login, across a reload", () => {
  const props = { setupCode: "7KQ2-M9XD-4TRF", onBack: () => {}, onDone: () => {} };

  // A tab whose storage holds the setup code, and the Name and Email typed before a reload.
  function tab(draft: { name: string; email: string }): TabStorage {
    const storage = new TabStorage();
    saveSetupCode(props.setupCode, storage);
    saveFirstMemberDraft(draft, storage);
    vi.stubGlobal("window", { sessionStorage: storage });
    return storage;
  }

  // Step 2's form fields, as its first paint hands them out. A field's onChange works as typing.
  function fields(): Map<unknown, ReactElement<Parameters<typeof TextField>[0]>> {
    renderToString(<KeptStep2 {...props} />);
    return new Map(elementsOf(step2Answer, TextField).map((field) => [field.props.label, field]));
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fills Name and Email from the tab's storage, and never the password", () => {
    tab({ name: "Alex", email: "alex@example.test" });
    const shown = fields();

    expect(shown.get("Name")?.props.value).toBe("Alex");
    expect(shown.get("Email")?.props.value).toBe("alex@example.test");
    expect(shown.get("Password, at least 12 characters")?.props.value).toBe("");
    const html = renderToString(<FirstMember {...props} />);
    expect(html).toContain('value="Alex"');
    expect(html).toContain('value="alex@example.test"');
  });

  it("keeps each change to Name and Email in the tab's storage, and never the password", () => {
    const storage = tab({ name: "Alex", email: "" });
    const shown = fields();

    shown.get("Email")?.props.onChange("alex@example.test");
    expect(savedFirstMemberDraft(storage)).toEqual({ name: "Alex", email: "alex@example.test" });
    shown.get("Name")?.props.onChange("Sam");
    expect(savedFirstMemberDraft(storage).name).toBe("Sam");

    shown.get("Password, at least 12 characters")?.props.onChange("a-long-password-1");
    expect([...storage.items.values()].join("")).not.toContain("a-long-password-1");
  });
});

// Step 1's and step 3's answers are statuses: an icon, a color, and words, in a region that screen
// readers hear as it changes.
describe("the setup page's status lines", () => {
  it("says the setup link worked with a ✓ in green, in a status region that is always there", () => {
    const worked = renderToString(<SetupLinkWorked worked={true} />);
    expect(worked).toMatch(/^<div role="status">/);
    expect(worked).toContain(
      '<span class="text-good"><span aria-hidden="true">✓ </span>Your setup link worked. The code is filled in.</span>',
    );
    expect(renderToString(<SetupLinkWorked worked={false} />)).toBe('<div role="status"></div>');
  });

  it("says what Copy did with an icon and a color, in a status region that is always there", () => {
    const copied = renderToString(<CopiedLine copied="copied" />);
    expect(copied).toContain('role="status"');
    expect(copied).toContain(
      '<span class="text-good"><span aria-hidden="true">✓ </span>Copied. Paste it into your password manager now.</span>',
    );
    const cannot = renderToString(<CopiedLine copied="cannot copy" />);
    expect(cannot).toContain('role="status"');
    expect(cannot).toContain('<span class="text-serious"><span aria-hidden="true">◆ </span>');
    expect(text(cannot)).toBe("◆ This browser cannot copy here. Select the key and copy it.");
    const before = renderToString(<CopiedLine copied={undefined} />);
    expect(before).toContain('role="status"');
    expect(text(before)).toBe("");
  });
});
