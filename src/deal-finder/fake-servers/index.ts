import { FakeApify } from "./apify.ts";
import { FakeKroger } from "./kroger.ts";

// The local fake servers for Apify and the Kroger API, on 127.0.0.1. Every test and dev run that
// uses the real readers points them here, so nothing reaches a real service.
export { FAKE_ACTOR_ROWS, FakeApify, type FakeRunStatus } from "./apify.ts";
export { FAKE_KROGER_LOCATIONS, FAKE_KROGER_PRODUCTS, FakeKroger } from "./kroger.ts";
export type { FakeAnswer, FakeRequest } from "./server.ts";

export type FakePriceSourceServers = {
  apify: FakeApify;
  kroger: FakeKroger;
  // The readers' options that point them at these servers.
  addresses: { apifyBaseUrl: string; krogerBaseUrl: string };
  close(): Promise<void>;
};

export async function startFakePriceSourceServers(): Promise<FakePriceSourceServers> {
  const apify = new FakeApify();
  const kroger = new FakeKroger();
  const [apifyBaseUrl, krogerBaseUrl] = await Promise.all([apify.start(), kroger.start()]);
  return {
    apify,
    kroger,
    addresses: { apifyBaseUrl, krogerBaseUrl },
    close: async () => {
      await Promise.all([apify.close(), kroger.close()]);
    },
  };
}
