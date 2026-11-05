import { describe, expect, it } from "vitest";
import { type InstallWindow, SERVICE_WORKER, setUpInstall } from "./install.ts";

// The installable app (spec 01, What the product is; spec 09, Security mode): over HTTPS the page
// registers the service worker; in plain-HTTP mode the install prompt and push are hidden.

function fakeWindow(protocol: string) {
  const seen = {
    registered: [] as string[],
    manifestRemoved: false,
    listeners: [] as ((event: Event) => void)[],
  };
  const page: InstallWindow = {
    location: { protocol },
    navigator: {
      serviceWorker: {
        register: async (url) => {
          seen.registered.push(url);
        },
      },
    },
    document: {
      querySelector: (selector) =>
        selector === 'link[rel="manifest"]'
          ? {
              remove: () => {
                seen.manifestRemoved = true;
              },
            }
          : null,
    },
    addEventListener: (_type, listener) => {
      seen.listeners.push(listener);
    },
  };
  return { page, seen };
}

describe("the installable app", () => {
  it("registers the service worker over HTTPS, and leaves the install prompt to the browser", () => {
    const { page, seen } = fakeWindow("https:");
    setUpInstall(page);

    expect(seen.registered).toEqual([SERVICE_WORKER]);
    expect(seen.manifestRemoved).toBe(false);
    expect(seen.listeners).toEqual([]);
  });

  it("hides the install prompt and push in plain-HTTP mode", () => {
    const { page, seen } = fakeWindow("http:");
    setUpInstall(page);

    expect(seen.registered).toEqual([]);
    expect(seen.manifestRemoved).toBe(true);
    const prompt = new Event("beforeinstallprompt", { cancelable: true });
    for (const listener of seen.listeners) listener(prompt);
    expect(prompt.defaultPrevented).toBe(true);
  });
});
