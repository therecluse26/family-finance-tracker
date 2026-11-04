import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AiView } from "../../../ai/ai-view.ts";
import { AiProviderForm, AiStatusLine, dataUseLine, statusLine, todayHere } from "./Ai.tsx";

// Settings → AI, as the browser paints it once the AI settings have loaded.

const OPENAI: AiView = {
  provider: "openai",
  keySet: true,
  baseUrl: null,
  gatewayTokenSet: false,
  quickModel: "gpt-6-luna",
  writerModel: "gpt-6.1-terra",
  status: { state: "on" },
};

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/<!-- -->/g, "");

describe("Settings → AI", () => {
  it("shows each status line", () => {
    const today = "2026-11-20";

    expect(statusLine({ state: "on" }, today)).toBe("AI is on");
    expect(statusLine({ state: "waits for history" }, today)).toBe("AI waits for history to load");
    expect(statusLine({ state: "cost cap", until: "2026-12-01" }, today)).toBe(
      "AI paused until Dec 1: AI cost cap reached",
    );
    expect(statusLine({ state: "key rejected" }, today)).toBe(
      "AI paused: the AI provider rejected the key",
    );
    expect(text(renderToString(<AiStatusLine ai={OPENAI} today={today} />))).toBe("AI is on");
  });

  it("takes today in the Household time zone, not in UTC", () => {
    // 9 PM in New York on Dec 31 is already Jan 1 in UTC, so a pause into January is next year.
    const evening = new Date("2027-01-01T02:00:00Z");
    const today = todayHere(evening, "America/New_York");

    expect(today).toBe("2026-12-31");
    expect(statusLine({ state: "cost cap", until: "2027-01-05" }, today)).toBe(
      "AI paused until Jan 5, 2027: AI cost cap reached",
    );
  });

  it("starts a new AI provider on Anthropic's default models, with the key as a password field", () => {
    const html = renderToString(<AiProviderForm ai={null} onSaved={() => {}} />);

    expect(html).toContain('value="claude-haiku-5-5"');
    expect(html).toContain('value="claude-sonnet-5-5"');
    expect(html).toContain('type="password"');
    expect(text(html)).toContain("Anthropic workspace limit");
    expect(text(html)).toContain("The app does not check it.");
  });

  it("shows only that the key is set, the saved models, and a link to the OpenAI project limit", () => {
    const html = renderToString(<AiProviderForm ai={OPENAI} onSaved={() => {}} />);

    expect(html).toContain('placeholder="Set. Enter a new key to change it."');
    expect(html).toContain('value="gpt-6-luna"');
    expect(html).toContain('value="gpt-6.1-terra"');
    expect(html).toContain('href="https://platform.openai.com/settings/organization/projects"');
  });

  it("says the app cannot check an OpenAI-compatible endpoint's data use", () => {
    const html = renderToString(
      <AiProviderForm
        ai={{
          ...OPENAI,
          provider: "openai-compatible",
          keySet: false,
          baseUrl: "http://ollama.local:11434/v1",
          quickModel: "llama-small",
          writerModel: "llama-large",
        }}
        onSaved={() => {}}
      />,
    );

    expect(text(html)).toContain("The app cannot check this endpoint");
    expect(text(html)).not.toContain("usage limit");
  });

  it("names each AI provider's data-use setting, and the gateway's", () => {
    expect(dataUseLine("openai", null)).toContain("store: false");
    expect(dataUseLine("openrouter", null)).toContain("data_collection: deny");
    expect(dataUseLine("anthropic", null)).toContain("never sends it feedback");
    expect(
      dataUseLine("anthropic", "https://gateway.ai.cloudflare.com/v1/a/g/anthropic"),
    ).toContain("Cloudflare AI Gateway");
  });

  it("asks for the gateway token only with a Cloudflare AI Gateway base URL", () => {
    const plain = renderToString(<AiProviderForm ai={OPENAI} onSaved={() => {}} />);
    const gateway = renderToString(
      <AiProviderForm
        ai={{ ...OPENAI, baseUrl: "https://gateway.ai.cloudflare.com/v1/a/g/openai" }}
        onSaved={() => {}}
      />,
    );

    expect(text(plain)).not.toContain("Gateway token");
    expect(text(gateway)).toContain("Gateway token");
  });
});
