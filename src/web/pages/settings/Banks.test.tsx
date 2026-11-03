import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlaidView } from "../../../bank/plaid-view.ts";
import { ItemsUsedForm, PlaidKeysForm } from "./Banks.tsx";

// Settings → Banks, as the browser paints it once the Plaid settings have loaded.

const NO_KEYS: PlaidView = {
  clientId: null,
  secretSet: false,
  itemsUsed: 0,
  appItems: 0,
  itemLimit: 10,
};

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/<!-- -->/g, "");

describe("Settings → Banks", () => {
  it("shows at least N of 10 used", () => {
    const html = renderToString(
      <ItemsUsedForm plaid={{ ...NO_KEYS, itemsUsed: 3, appItems: 2 }} onSaved={() => {}} />,
    );

    expect(text(html)).toContain("At least 3 of 10 used");
    expect(html).toContain('min="2"');
  });

  it("asks for the client ID, the Production secret, and a code, and shows only that the secret is set", () => {
    const before = renderToString(<PlaidKeysForm plaid={NO_KEYS} onSaved={() => {}} />);
    const after = renderToString(
      <PlaidKeysForm
        plaid={{ ...NO_KEYS, clientId: "client-id-shown", secretSet: true }}
        onSaved={() => {}}
      />,
    );

    expect(text(before)).toContain("No Plaid keys yet.");
    expect(text(before)).toContain("Production secret");
    expect(text(before)).not.toMatch(/sandbox/i);
    expect(before).toContain('type="password"');
    expect(text(after)).toContain("Client ID client-id-shown. The secret is set.");
  });
});
