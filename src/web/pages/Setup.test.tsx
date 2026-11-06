import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SetupProgressView } from "../../server/setup-views.ts";
import { WizardHeader } from "./Setup.tsx";

// The setup page's header, as the browser first paints it (spec 12, Order and resume rules). The page
// renders it with the step on the screen, the furthest step reached, and the server's progress, which
// it reads after Skip for now and after a reload alike.

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

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

    expect(text(html)).toBe(
      "Step 6 of 6 ✓ Setup link ✓ Your login ✓ Master key ✓ Household 5. Banks (skipped) 6. Finish Finish",
    );
  });

  it("shows a Banks step done once a bank is linked, and before any progress is read", () => {
    expect(
      text(
        renderToString(
          <WizardHeader shown="finish" reached="finish" progress={progress("done")} />,
        ),
      ),
    ).toContain("✓ Household ✓ Banks 6. Finish");
    expect(
      text(renderToString(<WizardHeader shown="banks" reached="banks" progress={undefined} />)),
    ).toBe(
      "Step 5 of 6 ✓ Setup link ✓ Your login ✓ Master key ✓ Household 5. Banks 6. Finish Banks",
    );
  });
});
