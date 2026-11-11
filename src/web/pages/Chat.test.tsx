import { type ReactElement, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiBoxInsightCardView, AiBoxNoteView } from "../../server/ai-box-views.ts";
import type { ChatStatusView, ChatThreadView } from "../../server/chat-views.ts";
import {
  askAboutAlertNote,
  askAboutInsightCard,
  askAboutOf,
  askAboutProposal,
  DROPPED_LINE,
  INPUT_PLACEHOLDER,
  PRIVACY_NOTICE,
  problemOf,
  SEND_ANYWAY,
  WAITS_FOR_HISTORY,
} from "../chat.ts";
import { AttachedNote, Chat, Composer, NewThread, ThreadList, ThreadMessages } from "./Chat.tsx";

// The Chat page's parts as the browser first paints them (spec 07, Chat page). The requests go
// through the app in src/server/chat-api.test.ts.

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

// A part inside a router, as the page holds it.
const render = (element: ReactElement) =>
  renderToString(
    <RouterProvider
      router={createMemoryRouter([{ path: "*", element }], { initialEntries: ["/chat"] })}
    />,
  );

const message = (id: string, author: "Member" | "AI", name: string, words: string) => ({
  id,
  author,
  name,
  text: words,
  createdAt: "2026-10-20T16:00:00.000Z",
});

const thread = (fields: Partial<ChatThreadView> = {}): ChatThreadView => ({
  id: "t1",
  title: "How are we doing?",
  note: null,
  messages: [
    message("q1", "Member", "Alice", "How are we doing?"),
    message("a1", "AI", "AI", "You are **$120** under Budget."),
    message("q2", "Member", "Bob", "And Groceries?"),
  ],
  firstSent: null,
  answering: false,
  proposals: [],
  shoppingListChanges: [],
  you: "Alice",
  ...fields,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the page", () => {
  it("fills the screen above the phone's tab bar with no fixed overlay, under one hidden <h1>", () => {
    const html = render(<Chat />);
    const main = /<main class="([^"]*)"[^>]*data-slot="chat-page"/.exec(html)?.[1]?.split(" ");

    // One heading, drawn before anything loads, for screen readers and the focus a menu choice
    // moves; as on the board, the open thread's title heads the pane.
    expect([...html.matchAll(/<h1[^>]*>(.*?)<\/h1>/g)].map((match) => match[0])).toEqual([
      '<h1 class="sr-only">Chat</h1>',
    ]);
    // The page takes back the shell's padding and is the screen's height, less the 59 px tab bar
    // below 900 px; nothing in it is fixed.
    expect(main).toEqual(
      expect.arrayContaining([
        "h-dvh",
        "-mb-24",
        "pb-[calc(59px+env(safe-area-inset-bottom))]",
        "min-[900px]:-mb-12",
        "min-[900px]:pb-0",
      ]),
    );
    expect(html).not.toMatch(/class="[^"]*\bfixed\b/);
  });

  it("keeps the input in view on a short phone screen: the thread list gives up its room", () => {
    const classesOf = (html: string, pattern: RegExp) => (pattern.exec(html)?.[1] ?? "").split(" ");
    const list = classesOf(
      render(<ThreadList threads={[]} open={undefined} today="2026-11-06" zone="UTC" />),
      /<nav aria-label="Chat threads" class="([^"]*)"/,
    );
    const pane = render(<NewThread status="ready" ask={null} onStarted={() => {}} />);

    // The list is at most 160 px tall, and shrinks below that, scrolling inside itself.
    expect(list).toEqual(
      expect.arrayContaining(["max-h-40", "min-h-0", "shrink", "overflow-y-auto"]),
    );
    expect(list).not.toContain("shrink-0");
    // The pane is never shorter than its header and input below 768 px; the messages scroll and
    // do not count toward that.
    expect(classesOf(pane, /<section aria-label="New thread" class="([^"]*)"/)).toEqual(
      expect.arrayContaining(["min-h-min", "md:min-h-0", "flex-1"]),
    );
    expect(classesOf(pane, /class="([^"]*)" data-slot="chat-scroll"/)).toEqual(
      expect.arrayContaining(["overflow-y-auto", "[contain:size]"]),
    );
  });
});

describe("Ask about this", () => {
  const note = { id: "n1", title: "Restaurants is over Budget for Oct 2026" } as AiBoxNoteView;

  it("opens a new thread with the note attached and the drafted question, and sends nothing before Send", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const ask = askAboutOf(askAboutAlertNote(note));

    const html = render(<NewThread status="ready" ask={ask} onStarted={() => {}} />);

    expect(text(html)).toContain("Alert note: Restaurants is over Budget for Oct 2026");
    expect(html).toContain(
      ">Tell me more about this: Restaurants is over Budget for Oct 2026</textarea>",
    );
    expect(html).not.toContain(`disabled=""`);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("opens a new thread with an Insight card attached, as for an Alert note", () => {
    const card = { id: "c1", title: "Delivery fees add up" } as AiBoxInsightCardView;
    const ask = askAboutOf(askAboutInsightCard(card));
    expect(ask).toEqual({ kind: "Insight card", id: "c1", title: "Delivery fees add up" });

    const html = render(<NewThread status="ready" ask={ask} onStarted={() => {}} />);

    expect(text(html)).toContain("Insight card: Delivery fees add up");
    expect(html).toContain(">Tell me more about this: Delivery fees add up</textarea>");
  });

  it("names a Proposal by its changes, and reads only a note it knows from the page's state", () => {
    expect(
      askAboutProposal({
        id: "p1",
        changes: ["Restaurants Budget: $600 → $480"],
      } as Parameters<typeof askAboutProposal>[0]),
    ).toEqual({ kind: "Proposal", id: "p1", title: "Restaurants Budget: $600 → $480" });
    expect(askAboutOf(null)).toBeNull();
    expect(askAboutOf({ answer: true })).toBeNull();
    expect(askAboutOf({ kind: "Transaction", id: "x", title: "y" })).toBeNull();
    expect(askAboutOf({ kind: "Alert note", id: 1, title: "y" })).toBeNull();
  });
});

describe("a thread", () => {
  it("shows who wrote each message, bolds key numbers, and marks the turns no longer sent", () => {
    const html = render(
      <ThreadMessages thread={thread({ firstSent: "a1" })} onChanged={() => {}} onAsk={() => {}} />,
    );

    expect(text(html)).toBe(
      `Alice How are we doing? ${DROPPED_LINE} AI You are $120 under Budget. Bob And Groceries?`,
    );
    expect(html).toContain("<strong>$120</strong>");
    expect(
      text(render(<ThreadMessages thread={thread()} onChanged={() => {}} onAsk={() => {}} />)),
    ).not.toContain(DROPPED_LINE);
  });

  it("shows the answer as it streams", () => {
    const html = render(
      <ThreadMessages
        thread={thread()}
        live={{ answer: "Groceries are at **$310**" }}
        onChanged={() => {}}
        onAsk={() => {}}
      />,
    );
    expect(text(html)).toMatch(/Bob And Groceries\? AI Groceries are at \$310$/u);

    // The new question shows under the signed-in Member's name until the thread reloads.
    const asked = render(
      <ThreadMessages
        thread={thread()}
        live={{ question: "And Dining?", answer: "" }}
        onChanged={() => {}}
        onAsk={() => {}}
      />,
    );
    expect(text(asked)).toMatch(/Bob And Groceries\? Alice And Dining\? AI …$/u);
  });

  it("breaks a long word in a message inside the page", () => {
    const word = "x".repeat(90);
    const html = render(
      <ThreadMessages
        thread={thread({ messages: [message("q1", "Member", "Alice", word)] })}
        onChanged={() => {}}
        onAsk={() => {}}
      />,
    );
    expect(html).toMatch(/<p class="[^"]*\bwrap-anywhere\b[^"]*">x{90}<\/p>/u);
  });

  it("shows each line of the attached note, two that match too, each under its own key", () => {
    const line = "Card interest: $12.50 on Northwind card on Oct 18.";
    const note = { kind: "Alert", title: "2 Card interest or fee charges", lines: [line, line] };

    expect(text(render(<AttachedNote note={note} />))).toBe(
      `Alert: 2 Card interest or fee charges ${line} ${line}`,
    );
    // The server render checks no key, so the keys are read from the elements.
    const [, lines] = (AttachedNote({ note }) as ReactElement<{ children: ReactElement[][] }>).props
      .children;
    const keys = (lines ?? []).map((each) => each.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("lists the threads, the open one marked", () => {
    const html = render(
      <ThreadList
        threads={[
          { id: "t2", title: "Rent question", lastMessageAt: "2026-10-20T17:00:00.000Z" },
          { id: "t1", title: "How are we doing?", lastMessageAt: "2026-10-20T16:00:00.000Z" },
        ]}
        open="t1"
        today="2026-11-03"
        zone="America/New_York"
      />,
    );
    // Each thread shows the day of its last message, in the browser's time zone.
    expect(text(html)).toBe("New thread Rent question Oct 20 How are we doing? Oct 20");
    expect(html).toContain('aria-current="page" class="block truncate');
  });
});

describe("the input", () => {
  it("shows the privacy notice and the placeholder", () => {
    const html = render(
      <Composer status="ready" draft="" onDraft={() => {}} busy={false} onSend={() => {}} />,
    );
    expect(text(html)).toContain(PRIVACY_NOTICE);
    expect(html).toContain(`placeholder="${INPUT_PLACEHOLDER}"`);
    expect(html).not.toContain(`disabled=""`);
  });

  it("waits until history has loaded", () => {
    const html = render(
      <Composer
        status="waits for history"
        draft=""
        onDraft={() => {}}
        busy={false}
        onSend={() => {}}
      />,
    );
    expect(text(html)).toContain(WAITS_FOR_HISTORY);
    expect(html).toContain(`disabled=""`);
  });

  it('reads a refusal, and "Send anyway?" from the route or a failed answer', () => {
    expect(problemOf(JSON.stringify({ error: "Send anyway?", pause: "send anyway?" }))).toEqual({
      error: "Send anyway?",
      sendAnyway: true,
      notStored: true,
    });
    expect(problemOf("Chat reached the AI cost cap. Send anyway?")).toEqual({
      error: "Chat reached the AI cost cap. Send anyway?",
      sendAnyway: true,
      notStored: false,
    });
    expect(problemOf("The AI provider did not answer.")).toEqual({
      error: "The AI provider did not answer.",
      sendAnyway: false,
      notStored: false,
    });
  });
});

// A stand-in for the browser's DOM, with just what React needs to mount a part in Node, run its
// effects, and take a key press or a submit. The repo has no DOM test environment.
type Listener = (event: object) => void;

class FakeNode {
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  readonly style: Record<string, string> = {};
  value = "";
  readonly nodeType: number;
  readonly nodeName: string;
  readonly ownerDocument: FakeDocument | null;
  nodeValue: string | null;
  readonly namespaceURI: string;

  constructor(
    nodeType: number,
    nodeName: string,
    ownerDocument: FakeDocument | null,
    nodeValue: string | null = null,
    namespaceURI = "http://www.w3.org/1999/xhtml",
  ) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.ownerDocument = ownerDocument;
    this.nodeValue = nodeValue;
    this.namespaceURI = namespaceURI;
  }

  get tagName() {
    return this.nodeName;
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes.at(-1) ?? null;
  }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  appendChild(child: FakeNode) {
    return this.insertBefore(child, null);
  }
  insertBefore(child: FakeNode, before: FakeNode | null) {
    child.parentNode?.removeChild(child);
    const at = before === null ? this.childNodes.length : this.childNodes.indexOf(before);
    this.childNodes.splice(at, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child: FakeNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }
  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((each) => each !== listener),
    );
  }
  get textContent(): string {
    if (this.nodeType === 3) return this.nodeValue ?? "";
    return this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(words: string) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (words !== "") this.appendChild(new FakeNode(3, "#text", this.ownerDocument, words));
  }
}

// One window for the file: React still reads it as a test's last answer settles.
const fakeWindow: { document?: FakeDocument } = {
  event: undefined,
  HTMLIFrameElement: class {},
  CompositionEvent: class {},
  addEventListener() {},
  removeEventListener() {},
} as { document?: FakeDocument };

class FakeDocument extends FakeNode {
  readonly defaultView = fakeWindow;
  readonly activeElement = null;
  // React listens for "input" only where the document offers it.
  readonly oninput = null;
  readonly documentElement: FakeNode;
  readonly body: FakeNode;

  constructor() {
    super(9, "#document", null);
    this.documentElement = this.appendChild(this.createElement("html"));
    this.body = this.documentElement.appendChild(this.createElement("body"));
  }
  createElement(tag: string) {
    return new FakeNode(1, tag.toUpperCase(), this);
  }
  createElementNS(namespace: string, tag: string) {
    return new FakeNode(1, tag, this, null, namespace);
  }
  createTextNode(words: string) {
    return new FakeNode(3, "#text", this, words);
  }
}

const roots: Root[] = [];

// A part mounted as the browser mounts it: under StrictMode, as in development (src/web/main.tsx),
// or without it, as in the built app.
async function mount(element: ReactElement, strict = true) {
  const document = new FakeDocument();
  fakeWindow.document = document;
  Object.assign(globalThis, { window: fakeWindow, document });
  // React reads what the browser offers once, as it loads, so it loads after the fake window.
  const { createRoot } = await import("react-dom/client");
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container as unknown as Element);
  roots.push(root);
  root.render(strict ? <StrictMode>{element}</StrictMode> : element);
  return { container };
}

const findNode = (node: FakeNode, name: string): FakeNode | undefined =>
  node.nodeName === name
    ? node
    : node.childNodes.map((child) => findNode(child, name)).find((found) => found !== undefined);

async function nodeOf(container: FakeNode, name: string) {
  await vi.waitFor(() => expect(findNode(container, name)).toBeDefined());
  return findNode(container, name) as FakeNode;
}

// An event the browser sends from `target` to the page's root, where React listens.
function dispatch(container: FakeNode, target: FakeNode, type: string, fields: object = {}) {
  const event = {
    type,
    target,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    isComposing: false,
    timeStamp: 0,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
    ...fields,
  };
  for (const listener of container.listeners.get(type) ?? []) listener(event);
  return event;
}

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
});

describe("Enter in the input", () => {
  async function press(
    key: object,
    fields: { draft?: string; busy?: boolean; status?: ChatStatusView } = {},
  ) {
    const onSend = vi.fn();
    const { container } = await mount(
      <Composer
        status={fields.status ?? "ready"}
        draft={fields.draft ?? "How are we doing?"}
        onDraft={() => {}}
        busy={fields.busy ?? false}
        onSend={onSend}
      />,
    );
    const input = await nodeOf(container, "TEXTAREA");
    const event = dispatch(container, input, "keydown", { key: "Enter", keyCode: 13, ...key });
    return { onSend, event, container };
  }

  it("sends the message, as Send does", async () => {
    const { onSend, event } = await press({});
    expect(onSend).toHaveBeenCalledExactlyOnceWith(false);
    expect(event.defaultPrevented).toBe(true);
  });

  it('asks "Send anyway?" first at the AI cost cap, as Send does', async () => {
    const { onSend, container } = await press({}, { status: "send anyway?" });
    await vi.waitFor(() => expect(container.textContent).toContain(SEND_ANYWAY));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("adds a line break with Shift", async () => {
    const { onSend, event } = await press({ shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves Enter to an input method while it composes text", async () => {
    for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
      const { onSend, event } = await press(composing);
      expect(onSend).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it("sends nothing with an empty draft, while an answer is on its way, or while Chat waits", async () => {
    for (const fields of [
      { draft: "  " },
      { busy: true },
      { status: "waits for history" as const },
    ]) {
      const { onSend } = await press({}, fields);
      expect(onSend).not.toHaveBeenCalled();
    }
  });
});

describe("a new thread's first answer", () => {
  const card = { id: "c1", title: "Delivery fees add up" } as AiBoxInsightCardView;
  const QUESTION = "Tell me more about this: Delivery fees add up";
  const ANSWER = "Delivery fees came to **$42** in Oct 2026.";

  // Chat's routes behind a fake fetch, with the answer as the stream useChat reads. With `stores`
  // false the answer never reaches the thread, as after a failed answer.
  function fakeApp(stores = true) {
    const stored = thread({
      title: QUESTION,
      messages: [message("q1", "Member", "Alice", QUESTION)],
    });
    // Each answer request, and whether useChat had stopped it before it went out.
    const answers: string[] = [];
    const stream = (chunks: object[]) =>
      new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } },
      );
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const { pathname } = new URL(url, "http://app.test");
      const method = init?.method ?? "GET";
      if (pathname === "/api/chat" && method === "GET") {
        const item = { id: "t1", title: QUESTION, lastMessageAt: "2026-10-20T16:00:00.000Z" };
        return Response.json({ status: "ready", threads: [item] });
      }
      if (pathname === "/api/chat/threads" && method === "POST") {
        return Response.json({ threadId: "t1" });
      }
      if (pathname === "/api/chat/threads/t1") return Response.json(stored);
      if (pathname === "/api/chat" && method === "POST") {
        const stopped = init?.signal?.aborted === true;
        answers.push(stopped ? "stopped" : "sent");
        if (stopped) throw new DOMException("Stopped.", "AbortError");
        if (stores) stored.messages = [...stored.messages, message("a1", "AI", "AI", ANSWER)];
        return stream([
          { type: "start" },
          { type: "text-start", id: "x" },
          { type: "text-delta", id: "x", delta: ANSWER },
          { type: "text-end", id: "x" },
          { type: "finish" },
        ]);
      }
      return new Response("Not found", { status: 404 });
    });
    return { answers };
  }

  // The Chat page opened from "Ask about this" on an Insight card, and Send pressed.
  async function sendFirstMessage(strict: boolean) {
    const router = createMemoryRouter(
      [
        { path: "/chat", Component: Chat },
        { path: "/chat/:id", Component: Chat },
      ],
      { initialEntries: [{ pathname: "/chat", state: askAboutInsightCard(card) }] },
    );
    const { container } = await mount(<RouterProvider router={router} />, strict);
    dispatch(container, await nodeOf(container, "FORM"), "submit");
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/chat/t1"));
    return { router, container };
  }

  it.each([
    ["under StrictMode, as in development", true],
    ["without it, as in the built app", false],
  ])("starts once when the thread opens after Send, %s", async (_, strict) => {
    const { answers } = fakeApp();
    const { container } = await sendFirstMessage(strict);

    await vi.waitFor(() => expect(container.textContent).toContain("Delivery fees came to $42"));
    expect(answers).toEqual(["sent"]);
    expect(container.textContent).not.toContain("This message has no answer yet.");
  });

  it("does not start again when the thread reloads, even with no answer stored", async () => {
    const { answers } = fakeApp(false);
    const { router } = await sendFirstMessage(true);
    await vi.waitFor(() => expect(answers).toEqual(["sent"]));
    await vi.waitFor(() => expect(router.state.location.state).toBeNull());

    for (const root of roots.splice(0)) root.unmount();
    const reloaded = createMemoryRouter([{ path: "/chat/:id", Component: Chat }], {
      initialEntries: [router.state.location],
    });
    const { container } = await mount(<RouterProvider router={reloaded} />);

    await vi.waitFor(() =>
      expect(container.textContent).toContain("This message has no answer yet."),
    );
    expect(answers).toEqual(["sent"]);
  });
});
