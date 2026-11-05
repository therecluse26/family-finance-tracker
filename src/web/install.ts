// The installable app (spec 01, What the product is; spec 09, Security mode). The page's scheme is
// APP_URL's: in HTTPS mode the server answers only requests its proxy marks as HTTPS.
// - Over HTTPS the page registers the service worker (sw.ts), which shows pushes, and the browser
//   may offer to install the app from its manifest.
// - In plain-HTTP mode the install prompt and push are hidden: the page drops the manifest link,
//   registers no service worker, and stops the browser's own install prompt. Settings, Alerts says
//   why.

// The parts of the browser window this file uses.
export type InstallWindow = {
  location: { protocol: string };
  navigator: {
    serviceWorker?: { register(url: string, options: { scope: string }): Promise<unknown> };
  };
  document: { querySelector(selector: string): { remove(): void } | null };
  addEventListener(type: "beforeinstallprompt", listener: (event: Event) => void): void;
};

export const SERVICE_WORKER = "/sw.js";

export function setUpInstall(page: InstallWindow): void {
  if (page.location.protocol === "https:") {
    page.navigator.serviceWorker?.register(SERVICE_WORKER, { scope: "/" }).catch(() => {
      // Without the service worker, the page works as before, without push.
    });
    return;
  }
  page.document.querySelector('link[rel="manifest"]')?.remove();
  page.addEventListener("beforeinstallprompt", (event) => event.preventDefault());
}
