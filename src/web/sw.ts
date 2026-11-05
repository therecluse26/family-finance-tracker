// The service worker (spec 01, What the product is; spec 06, Recipients and channels). It makes
// the app installable and shows each push: the Alert's kind as its title and its template text as
// its body, or a System notice's text. A tap opens the page the push names, in the app. vite-plugin-
// pwa builds it into sw.js. It imports nothing, so no package code ships in it, and it caches
// nothing: the app needs its server for every page.

// The parts of the service worker scope this file uses. The web app's type check reads the DOM
// types, which have no service worker scope.
type ExtendableEvent = { waitUntil(work: Promise<unknown>): void };
type PushEvent = ExtendableEvent & { data: { json(): unknown } | null };
type NotificationClickEvent = ExtendableEvent & {
  notification: { data: unknown; close(): void };
};
type WindowClient = {
  url: string;
  focus(): Promise<unknown>;
  navigate(url: string): Promise<unknown>;
};
type WorkerScope = {
  location: { origin: string };
  registration: {
    showNotification(
      title: string,
      options: { body: string; tag: string; icon: string; data: { url: string } },
    ): Promise<void>;
  };
  clients: {
    claim(): Promise<void>;
    matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<WindowClient[]>;
    openWindow(url: string): Promise<unknown>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: "push", listener: (event: PushEvent) => void): void;
  addEventListener(
    type: "notificationclick",
    listener: (event: NotificationClickEvent) => void,
  ): void;
};

const worker = self as unknown as WorkerScope;

type Shown = { title: string; body: string; url: string; tag: string };

// Only a path in the app: never another site.
const isAppPath = (url: unknown): url is string =>
  typeof url === "string" && url.startsWith("/") && !url.startsWith("//") && !url.includes("\\");

// The push as the server wrote it. A push the worker cannot read still shows a notification, as
// browsers require of every push.
function shownOf(event: PushEvent): Shown {
  const fallback: Shown = { title: "Family Finance Tracker", body: "", url: "/", tag: "push" };
  let data: unknown;
  try {
    data = event.data?.json();
  } catch {
    return fallback;
  }
  if (typeof data !== "object" || data === null) return fallback;
  const { title, body, url, tag } = data as Record<string, unknown>;
  return {
    title: typeof title === "string" && title !== "" ? title : fallback.title,
    body: typeof body === "string" ? body : fallback.body,
    url: isAppPath(url) ? url : fallback.url,
    tag: typeof tag === "string" && tag !== "" ? tag : fallback.tag,
  };
}

worker.addEventListener("install", (event) => event.waitUntil(worker.skipWaiting()));
worker.addEventListener("activate", (event) => event.waitUntil(worker.clients.claim()));

worker.addEventListener("push", (event) => {
  const shown = shownOf(event);
  event.waitUntil(
    worker.registration.showNotification(shown.title, {
      body: shown.body,
      tag: shown.tag,
      icon: "/icon-192.png",
      data: { url: shown.url },
    }),
  );
});

worker.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: unknown } | null)?.url;
  const target = new URL(isAppPath(url) ? url : "/", worker.location.origin).href;
  event.waitUntil(
    worker.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (open) => {
      const client = open.find((each) => new URL(each.url).origin === worker.location.origin);
      if (client === undefined) return worker.clients.openWindow(target);
      // navigate() fails on a window this worker does not control, such as one opened before it
      // was installed. A new window then opens at the same page.
      const moved = await client
        .focus()
        .then(() => client.navigate(target))
        .catch(() => null);
      return moved === null ? worker.clients.openWindow(target) : moved;
    }),
  );
});
