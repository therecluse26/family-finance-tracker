import { type UIMessage, useChat } from "@ai-sdk/react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import type {
  ChatMessageView,
  ChatProposalView,
  ChatStatusView,
  ChatThreadItemView,
  ChatThreadView,
} from "../../server/chat-views.ts";
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
import { ErrorLine, FIELD } from "../components/Fields.tsx";
import { ProposalCard } from "../components/Proposal.tsx";

// The Chat page (spec 07, Chat page; spec 08, Chat): the threads, newest first, and the open one.
// Every Member sees every thread, and each message shows who wrote it: a Member's name, or "AI".
// The answer shows as the AI writes it, through @ai-sdk/react's useChat. A failed answer shows its
// error with "Try again", and nothing retries by itself.

const BUTTON = "rounded border border-gray-300 px-3 py-1 disabled:opacity-50";
const SEND = "rounded bg-blue-700 px-4 py-2 text-white disabled:opacity-50";

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

function Message(props: { name: string; text: string; ai: boolean }) {
  return (
    <li className="min-w-0 rounded border border-gray-200 p-3" data-slot="chat-message">
      <p className="text-sm font-semibold text-gray-600">{props.name}</p>
      <p className="mt-1 whitespace-pre-wrap wrap-anywhere">
        {props.ai ? <AiWords text={props.text} /> : props.text}
      </p>
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
      />
    );
  }
  return (
    <li
      className="min-w-0 rounded border border-gray-200 p-3 text-sm wrap-anywhere"
      data-slot="chat-proposal"
    >
      <p className="font-semibold">Proposal: {STATUS_WORDS[proposal.status]}</p>
      {proposal.changes.map((change) => (
        <p key={change}>{change}</p>
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
        <li key="dropped" className="border-t border-gray-400 pt-1 text-sm text-gray-600">
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
    items.push(<Message key="live-answer" name="AI" text={props.live.answer || "…"} ai />);
  }
  // A Proposal whose answer failed still shows, after the messages.
  items.push(...proposalsOf(null));
  return (
    <ol aria-label="Messages" className="mt-3 flex flex-col gap-2">
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
    <form className="mt-3" onSubmit={submit}>
      <p className="text-sm text-gray-600" data-slot="chat-privacy">
        {PRIVACY_NOTICE}
      </p>
      {blocked === undefined ? null : (
        <p className="mt-2 text-gray-700" data-slot="chat-blocked">
          {blocked}
        </p>
      )}
      <textarea
        aria-label="Message"
        className={FIELD}
        rows={3}
        placeholder={INPUT_PLACEHOLDER}
        value={props.draft}
        disabled={blocked !== undefined}
        onChange={(event) => props.onDraft(event.target.value)}
      />
      {asking ? (
        <div className="mt-2 flex items-center gap-2" data-slot="send-anyway">
          <span>{SEND_ANYWAY}</span>
          <button
            type="button"
            className={SEND}
            disabled={props.busy}
            onClick={() => {
              setAsking(false);
              props.onSend(true);
            }}
          >
            Send
          </button>
          <button type="button" className={BUTTON} onClick={() => setAsking(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="submit"
          className={`${SEND} mt-2`}
          disabled={props.busy || blocked !== undefined}
        >
          Send
        </button>
      )}
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
    <div className="mt-3" data-slot="chat-problem">
      <ErrorLine error={props.problem.error} />
      <button
        type="button"
        className={`${BUTTON} mt-2`}
        disabled={props.busy}
        onClick={() => props.onTryAgain(props.problem.sendAnyway)}
      >
        {props.problem.sendAnyway ? "Send anyway" : "Try again"}
      </button>
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
      className="min-w-0 flex-1 wrap-anywhere"
      data-slot="chat-thread"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="min-w-0 text-lg font-semibold wrap-anywhere">{thread.title}</h2>
        <button type="button" className={`${BUTTON} shrink-0`} onClick={() => void remove()}>
          Delete thread
        </button>
      </div>
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
      <Composer status={props.status} draft={draft} onDraft={setDraft} busy={busy} onSend={send} />
    </section>
  );
}

function AttachedNote(props: { note: { kind: string; title: string; lines: string[] } }) {
  return (
    <div className="mt-2 rounded bg-gray-50 p-3 text-sm wrap-anywhere" data-slot="chat-note">
      <p className="font-semibold">
        {props.note.kind}: {props.note.title}
      </p>
      {props.note.lines.map((line) => (
        <p key={line}>{line}</p>
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
    <section aria-label="New thread" className="min-w-0 flex-1 wrap-anywhere" data-slot="chat-new">
      <h2 className="text-lg font-semibold">New thread</h2>
      {props.ask === null ? null : (
        <div className="mt-2 rounded bg-gray-50 p-3 text-sm wrap-anywhere" data-slot="chat-note">
          <p className="font-semibold">
            {props.ask.kind}: {props.ask.title}
          </p>
        </div>
      )}
      {problem === undefined ? null : (
        <Problem problem={problem} busy={busy} onTryAgain={(anyway) => void send(anyway)} />
      )}
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

export function ThreadList(props: { threads: ChatThreadItemView[]; open: string | undefined }) {
  return (
    <nav aria-label="Chat threads" className="min-w-0 md:w-64 md:shrink-0">
      <Link to="/chat" className={BUTTON}>
        New thread
      </Link>
      {props.threads.length === 0 ? (
        <p className="mt-2 text-sm text-gray-600">No threads yet.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1">
          {props.threads.map((thread) => (
            <li key={thread.id}>
              <Link
                to={`/chat/${thread.id}`}
                aria-current={thread.id === props.open ? "page" : undefined}
                className="block truncate rounded px-2 py-1 hover:bg-gray-100 aria-[current=page]:bg-gray-100"
              >
                {thread.title}
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
  return (
    <main>
      <h1 className="text-2xl font-semibold">Chat</h1>
      <ErrorLine error={error} />
      {list === undefined ? null : (
        <div className="mt-3 flex min-w-0 flex-col gap-4 md:flex-row">
          <ThreadList threads={list.threads} open={id} />
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
            <p className="text-gray-600">No Chat thread has this ID.</p>
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
    </main>
  );
}
