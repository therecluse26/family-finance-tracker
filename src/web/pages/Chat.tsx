import { type UIMessage, useChat } from "@ai-sdk/react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { calendarDateIn, dateLabel } from "../../format.ts";
import type {
  ChatMessageView,
  ChatProposalView,
  ChatStatusView,
  ChatThreadItemView,
  ChatThreadView,
} from "../../server/chat-views.ts";
import { browserZone } from "../browser-zone.ts";
import {
  type AskAbout,
  askAboutOf,
  askAboutProposal,
  type ChatProblem,
  DROPPED_LINE,
  deleteThread,
  draftQuestion,
  INPUT_PLACEHOLDER,
  loadChat,
  loadThread,
  PRIVACY_NOTICE,
  problemOf,
  SEND_ANYWAY,
  startThread,
  statusLine,
} from "../chat.ts";
import { Button, buttonClass } from "../components/Button.tsx";
import { ErrorLine } from "../components/Fields.tsx";
import { Page, PageHeading } from "../components/Page.tsx";
import { ProposalCard } from "../components/Proposal.tsx";
import { AiMark } from "../components/Status.tsx";

// The Chat page (spec 07, Chat page; spec 08, Chat): the threads, newest first, and the open one.
// Every Member sees every thread, and each message shows who wrote it: a Member's name, or "AI".
// The answer shows as the AI writes it, through @ai-sdk/react's useChat. A failed answer shows its
// error with "Try again", and nothing retries by itself.

// The board's faint grey behind the thread list and a Proposal. It has no token yet.
const FAINT = "bg-[#FBFBFC]";
// The input row's Send, as tall as the input. The shared Button has no 46 px size.
const SEND =
  "inline-flex h-[46px] shrink-0 items-center justify-center rounded-control bg-accent px-5 text-sm font-semibold text-white hover:bg-accent-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";
// The side padding of the thread's header, messages and input.
const GUTTER = "px-4 min-[900px]:px-7";
const EVERY_MEMBER = "Every Member sees every thread.";

// What the page shows after "Send": the new thread answers its first message once it opens.
type OpenState = { answer: true; sendAnyway: boolean };

const isOpenState = (state: unknown): state is OpenState =>
  typeof state === "object" && state !== null && (state as { answer?: unknown }).answer === true;

// AI text with its bold key numbers, such as **$480**, in bold. Everything else shows as written.
export function AiWords(props: { text: string }) {
  const pieces = props.text.split(/\*\*(.+?)\*\*/gu);
  return (
    <>
      {pieces.map((piece, index) =>
        // biome-ignore lint/suspicious/noArrayIndexKey: the pieces never move.
        index % 2 === 1 ? <strong key={index}>{piece}</strong> : piece,
      )}
    </>
  );
}

// The small ring the board shows while the AI works on an answer.
function Working() {
  return (
    <svg
      aria-hidden="true"
      className="mr-2 inline-block align-[-3px] motion-safe:animate-spin"
      width="18"
      height="18"
      viewBox="0 0 40 40"
    >
      <circle cx="20" cy="20" r="16" className="stroke-line" strokeWidth="5" fill="none" />
      <path
        d="M20 4a16 16 0 0 1 16 16"
        className="stroke-ai"
        strokeWidth="5"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

// A Member's message sits on the right in blue, under the Member's name. The AI's sits on the
// left in white, under the AI tag, which reads "AI".
function Message(props: { name: string; text: string; ai: boolean; working?: boolean }) {
  if (props.ai) {
    return (
      <li
        className="max-w-[88%] min-w-0 self-start rounded-card rounded-bl-[4px] border border-line bg-white px-4 py-3.5 min-[900px]:px-[18px]"
        data-slot="chat-message"
      >
        <p className="text-xs">
          <AiMark />
        </p>
        <p className="mt-1.5 leading-[1.55] whitespace-pre-wrap wrap-anywhere">
          {props.working === true ? <Working /> : null}
          <AiWords text={props.text} />
        </p>
      </li>
    );
  }
  return (
    <li
      className="max-w-[80%] min-w-0 self-end rounded-card rounded-br-[4px] bg-accent px-4 py-3 text-white"
      data-slot="chat-message"
    >
      <p className="text-xs text-white/85">{props.name}</p>
      <p className="mt-0.5 whitespace-pre-wrap wrap-anywhere">{props.text}</p>
    </li>
  );
}

const STATUS_WORDS: Record<Exclude<ChatProposalView["status"], "open">, string> = {
  accepted: "Accepted",
  skipped: "Skipped",
  replaced: "Replaced by a newer Proposal",
  expired: "Expired",
};

// A Proposal the thread's AI made: its card while open, or its change and how it closed.
function ThreadProposal(props: {
  proposal: ChatProposalView;
  onChanged: () => void;
  onAsk: (about: AskAbout) => void;
}) {
  const { proposal } = props;
  if (proposal.status === "open") {
    return (
      <ProposalCard
        proposal={proposal}
        onChanged={props.onChanged}
        onAsk={() => props.onAsk(askAboutProposal(proposal))}
        className="max-w-[88%] self-start"
      />
    );
  }
  return (
    <li
      className={`max-w-[88%] min-w-0 self-start rounded-[10px] border border-line ${FAINT} px-3.5 py-3 text-sm wrap-anywhere`}
      data-slot="chat-proposal"
    >
      <p className="text-small font-semibold text-muted">
        Proposal: {STATUS_WORDS[proposal.status]}
      </p>
      {proposal.changes.map((change) => (
        <p key={change} className="mt-0.5 text-ink-soft">
          {change}
        </p>
      ))}
    </li>
  );
}

// The thread's messages, the dropped-turns line above the first one the next call sends, and each
// Proposal under the answer that made it. `live` is the answer streaming now, if any.
export function ThreadMessages(props: {
  thread: ChatThreadView;
  live?: { question?: string; answer: string } | undefined;
  onChanged: () => void;
  onAsk: (about: AskAbout) => void;
}) {
  const { thread } = props;
  const proposalsOf = (answerId: string | null) =>
    thread.proposals
      .filter((proposal) => proposal.answerId === answerId)
      .map((proposal) => (
        <ThreadProposal
          key={proposal.id}
          proposal={proposal}
          onChanged={props.onChanged}
          onAsk={props.onAsk}
        />
      ));
  const items: ReactNode[] = [];
  for (const message of thread.messages) {
    if (message.id === thread.firstSent) {
      items.push(
        <li key="dropped" className="border-t border-field pt-1.5 text-small text-muted">
          {DROPPED_LINE}
        </li>,
      );
    }
    items.push(<ThreadMessage key={message.id} message={message} />);
    items.push(...proposalsOf(message.author === "AI" ? message.id : "none"));
  }
  if (props.live?.question !== undefined) {
    items.push(
      <Message key="live-question" name={props.thread.you} text={props.live.question} ai={false} />,
    );
  }
  if (props.live !== undefined) {
    items.push(
      <Message
        key="live-answer"
        name="AI"
        text={props.live.answer || "…"}
        ai
        working={props.live.answer === ""}
      />,
    );
  }
  // A Proposal whose answer failed still shows, after the messages.
  items.push(...proposalsOf(null));
  return (
    <ol aria-label="Messages" className="flex flex-col gap-[18px]">
      {items}
    </ol>
  );
}

function ThreadMessage(props: { message: ChatMessageView }) {
  const { message } = props;
  return <Message name={message.name} text={message.text} ai={message.author === "AI"} />;
}

// The input, with "Send", and "Send anyway?" first at the AI cost cap.
export function Composer(props: {
  status: ChatStatusView;
  draft: string;
  onDraft: (text: string) => void;
  busy: boolean;
  onSend: (sendAnyway: boolean) => void;
}) {
  const [asking, setAsking] = useState(false);
  const blocked = statusLine(props.status);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (props.draft.trim() === "") return;
    if (props.status === "send anyway?") setAsking(true);
    else props.onSend(false);
  }
  return (
    <form className={`-mt-px border-t border-line bg-white pt-4 pb-5 ${GUTTER}`} onSubmit={submit}>
      {blocked === undefined ? null : (
        <p className="mb-2 text-sm text-ink-soft" data-slot="chat-blocked">
          {blocked}
        </p>
      )}
      <div className="flex items-start gap-2.5">
        <textarea
          aria-label="Message"
          className="block min-h-[46px] min-w-0 flex-1 resize-y rounded-xl border border-field bg-white px-3.5 py-[11px] field-sizing-content disabled:bg-page"
          rows={1}
          placeholder={INPUT_PLACEHOLDER}
          value={props.draft}
          disabled={blocked !== undefined}
          onChange={(event) => props.onDraft(event.target.value)}
        />
        {asking ? null : (
          <button type="submit" className={SEND} disabled={props.busy || blocked !== undefined}>
            Send
          </button>
        )}
      </div>
      {asking ? (
        <div className="mt-2 flex flex-wrap items-center gap-2" data-slot="send-anyway">
          <span>{SEND_ANYWAY}</span>
          <Button
            type="button"
            size="small"
            disabled={props.busy}
            onClick={() => {
              setAsking(false);
              props.onSend(true);
            }}
          >
            Send
          </Button>
          <Button type="button" variant="outlined" size="small" onClick={() => setAsking(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
      <p className="mt-2 text-small text-muted" data-slot="chat-privacy">
        {PRIVACY_NOTICE}
      </p>
    </form>
  );
}

// A problem with "Try again", or with "Send anyway?" at the AI cost cap.
function Problem(props: {
  problem: ChatProblem;
  busy: boolean;
  onTryAgain: (sendAnyway: boolean) => void;
}) {
  return (
    <div className="mt-4" data-slot="chat-problem">
      <ErrorLine error={props.problem.error} />
      <Button
        type="button"
        variant="outlined"
        size="small"
        className="mt-2"
        disabled={props.busy}
        onClick={() => props.onTryAgain(props.problem.sendAnyway)}
      >
        {props.problem.sendAnyway ? "Send anyway" : "Try again"}
      </Button>
    </div>
  );
}

const textOf = (message: UIMessage | undefined) =>
  (message?.parts ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");

// The open thread, with its answer streaming from POST /api/chat as the AI writes it.
function OpenThread(props: {
  thread: ChatThreadView;
  status: ChatStatusView;
  answerFirst: OpenState | undefined;
  onChanged: () => Promise<void>;
  onAsk: (about: AskAbout) => void;
  onDeleted: () => void;
  // Once the first answer starts: the page's state stops asking for it, so a reload does not send
  // it again.
  onFirstAnswer: () => void;
}) {
  const { thread } = props;
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<ChatProblem | undefined>();
  const [error, setError] = useState<string | undefined>();
  // The text of the message being sent, which a refusal puts back in the input.
  const sending = useRef<string | undefined>(undefined);
  const chat = useChat({
    id: thread.id,
    onFinish: () => {
      void props.onChanged().then(() => chat.setMessages([]));
    },
    onError: (failed) => {
      const found = problemOf(failed.message);
      setProblem(found);
      if (found.notStored && sending.current !== undefined) setDraft(sending.current);
      sending.current = undefined;
      void props.onChanged().then(() => chat.setMessages([]));
    },
  });
  const busy = chat.status === "submitted" || chat.status === "streaming" || thread.answering;
  const last = thread.messages.at(-1);
  const unanswered = last?.author === "Member" && !busy;

  // "Try again", "Send anyway", or a new thread's first answer: the thread's last message again.
  function answerAgain(sendAnyway: boolean) {
    if (last === undefined) return;
    setProblem(undefined);
    sending.current = undefined;
    chat.setMessages([{ id: last.id, role: "user", parts: [{ type: "text", text: last.text }] }]);
    void chat.regenerate({ body: { sendAnyway } });
  }

  // A new thread answers its first message once, when it opens after "Send".
  const answered = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the thread opens.
  useEffect(() => {
    if (props.answerFirst === undefined || answered.current || !unanswered) return;
    answered.current = true;
    answerAgain(props.answerFirst.sendAnyway);
    props.onFirstAnswer();
  }, []);

  function send(sendAnyway: boolean) {
    const text = draft;
    if (text.trim() === "") return;
    setProblem(undefined);
    setDraft("");
    sending.current = text;
    void chat.sendMessage({ text }, { body: { sendAnyway } });
  }

  async function remove() {
    const failed = await deleteThread(thread.id);
    setError(failed);
    if (failed === undefined) props.onDeleted();
  }

  const question = chat.messages.find((message) => message.role === "user");
  const answer = chat.messages.findLast((message) => message.role === "assistant");
  const live =
    chat.status === "submitted" || chat.status === "streaming"
      ? {
          ...(question === undefined || question.id === last?.id
            ? {}
            : { question: textOf(question) }),
          answer: textOf(answer),
        }
      : undefined;

  return (
    <section
      aria-label={thread.title}
      className="flex min-w-0 flex-1 flex-col wrap-anywhere"
      data-slot="chat-thread"
    >
      <ThreadHeader title={thread.title}>
        <Button
          type="button"
          variant="outlined"
          size="small"
          className="shrink-0"
          onClick={() => void remove()}
        >
          Delete thread
        </Button>
      </ThreadHeader>
      <div className={`w-full max-w-[816px] flex-1 py-6 max-md:empty:hidden ${GUTTER}`}>
        <ErrorLine error={error} />
        {thread.note === null ? null : <AttachedNote note={thread.note} />}
        <ThreadMessages
          thread={thread}
          live={live}
          onChanged={() => void props.onChanged()}
          onAsk={props.onAsk}
        />
        {problem !== undefined ? (
          <Problem
            problem={problem}
            busy={busy}
            // A message the route refused is back in the input: it goes again from there.
            onTryAgain={problem.notStored ? send : answerAgain}
          />
        ) : unanswered && props.answerFirst === undefined ? (
          <Problem
            problem={{
              error: "This message has no answer yet.",
              sendAnyway: props.status === "send anyway?",
              notStored: false,
            }}
            busy={busy}
            onTryAgain={answerAgain}
          />
        ) : null}
      </div>
      <Composer status={props.status} draft={draft} onDraft={setDraft} busy={busy} onSend={send} />
    </section>
  );
}

// The thread's title in a white bar over its messages, with who sees it under it.
function ThreadHeader(props: { title: string; children?: ReactNode }) {
  return (
    <header
      className={`flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b border-line py-4 min-[900px]:py-5 ${GUTTER}`}
    >
      <div className="min-w-0 flex-[1_1_12rem]">
        <h2 className="text-lg font-bold wrap-anywhere min-[900px]:text-xl">{props.title}</h2>
        <p className="mt-0.5 text-small text-muted">{EVERY_MEMBER}</p>
      </div>
      {props.children}
    </header>
  );
}

function AttachedNote(props: { note: { kind: string; title: string; lines: string[] } }) {
  return (
    <div
      className={`mb-[18px] rounded-[10px] border border-line ${FAINT} px-3.5 py-3 text-sm wrap-anywhere`}
      data-slot="chat-note"
    >
      <p className="font-semibold">
        {props.note.kind}: {props.note.title}
      </p>
      {props.note.lines.map((line) => (
        <p key={line} className="mt-0.5 text-ink-soft">
          {line}
        </p>
      ))}
    </div>
  );
}

// A new thread: the input, and the note "Ask about this" attached, with its drafted question.
// Nothing goes to the server until the Member presses Send.
export function NewThread(props: {
  status: ChatStatusView;
  ask: AskAbout | null;
  onStarted: (threadId: string, sendAnyway: boolean) => void;
}) {
  const [draft, setDraft] = useState(props.ask === null ? "" : draftQuestion(props.ask.title));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ChatProblem | undefined>();

  async function send(sendAnyway: boolean) {
    setBusy(true);
    const started = await startThread(draft, props.ask, sendAnyway);
    setBusy(false);
    if ("threadId" in started) props.onStarted(started.threadId, sendAnyway);
    else setProblem(started);
  }

  return (
    <section
      aria-label="New thread"
      className="flex min-w-0 flex-1 flex-col wrap-anywhere"
      data-slot="chat-new"
    >
      <ThreadHeader title="New thread" />
      <div className={`w-full max-w-[816px] flex-1 py-6 max-md:empty:hidden ${GUTTER}`}>
        {props.ask === null ? null : (
          <div
            className={`rounded-[10px] border border-line ${FAINT} px-3.5 py-3 text-sm wrap-anywhere`}
            data-slot="chat-note"
          >
            <p className="font-semibold">
              {props.ask.kind}: {props.ask.title}
            </p>
          </div>
        )}
        {problem === undefined ? null : (
          <Problem problem={problem} busy={busy} onTryAgain={(anyway) => void send(anyway)} />
        )}
      </div>
      <Composer
        status={props.status}
        draft={draft}
        onDraft={setDraft}
        busy={busy}
        onSend={(anyway) => void send(anyway)}
      />
    </section>
  );
}

// The threads, newest first, each with the day of its last message. On a phone the list sits over
// the open thread; from 768 px it is a column at the left.
export function ThreadList(props: {
  threads: ChatThreadItemView[];
  open: string | undefined;
  today: string;
  zone: string;
}) {
  return (
    <nav
      aria-label="Chat threads"
      className={`min-w-0 border-b border-line ${FAINT} px-3 py-4 md:w-[260px] md:shrink-0 md:border-r md:border-b-0 md:py-5`}
    >
      <Link to="/chat" className={`${buttonClass("primary")} w-full`}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14">
          <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        New thread
      </Link>
      {props.threads.length === 0 ? (
        <p className="mt-3.5 px-3.5 text-small text-muted">No threads yet.</p>
      ) : (
        <ul className="mt-3.5 flex flex-col gap-0.5">
          {props.threads.map((thread) => (
            <li key={thread.id}>
              <Link
                to={`/chat/${thread.id}`}
                aria-current={thread.id === props.open ? "page" : undefined}
                className="block truncate rounded-[10px] px-3.5 py-3 text-ink hover:bg-line-soft aria-[current=page]:bg-nav-current"
              >
                <span className="block truncate text-sm font-semibold">{thread.title}</span>
                <span className="mt-0.5 block text-small text-muted">
                  {dateLabel(
                    calendarDateIn(new Date(thread.lastMessageAt), props.zone),
                    props.today,
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

export function Chat() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [list, setList] = useState<{ status: ChatStatusView; threads: ChatThreadItemView[] }>();
  const [thread, setThread] = useState<ChatThreadView | null>();
  const [error, setError] = useState<string | undefined>();

  async function load() {
    try {
      setList(await loadChat());
      setThread(id === undefined ? null : ((await loadThread(id)) ?? null));
      setError(undefined);
    } catch {
      setError("Chat did not load.");
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: load when the open thread changes.
  useEffect(() => {
    setThread(undefined);
    void load();
  }, [id]);

  const ask = (about: AskAbout) => navigate("/chat", { state: about });
  const zone = browserZone();
  return (
    <Page width="wide">
      <PageHeading title="Chat" />
      <ErrorLine error={error} />
      {list === undefined ? null : (
        <div className="flex min-w-0 flex-col overflow-hidden rounded-card border border-line bg-white md:min-h-[620px] md:flex-row">
          <ThreadList
            threads={list.threads}
            open={id}
            today={calendarDateIn(new Date(), zone)}
            zone={zone}
          />
          {id === undefined ? (
            <NewThread
              key={location.key}
              status={list.status}
              ask={askAboutOf(location.state)}
              onStarted={(threadId, sendAnyway) =>
                navigate(`/chat/${threadId}`, { state: { answer: true, sendAnyway } })
              }
            />
          ) : thread === undefined ? null : thread === null ? (
            <p className={`flex-1 py-6 text-muted ${GUTTER}`}>No Chat thread has this ID.</p>
          ) : (
            <OpenThread
              key={thread.id}
              thread={thread}
              status={list.status}
              answerFirst={isOpenState(location.state) ? location.state : undefined}
              onChanged={load}
              onAsk={ask}
              onDeleted={() => navigate("/chat")}
              onFirstAnswer={() => navigate(`/chat/${thread.id}`, { replace: true })}
            />
          )}
        </div>
      )}
    </Page>
  );
}
