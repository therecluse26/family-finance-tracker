import { Link } from "react-router";
import { useAiActivityAnnouncement, useAiActivityLine } from "./ai-activity.ts";
import { StatusText } from "./components/Status.tsx";

// The live AI status in the main menu (spec 07, Main menu; spec 08, Live AI status): "● AI
// working: Categories" while background AI works, linked to Settings, AI. With no work it is empty
// and takes no room. A polite live region, seen by screen readers only, says "AI working" when the
// sign shows and "AI work finished" when it hides, and not each step: the link has the full line.
// A run's percent never gets cut: only the words before it shorten.
// From 900 px wide it sits in the menu column under the app's name. At phone width it is a thin
// line at the top of the bar at the foot of the screen; the open menu shows it under the app's name.
export function AiActivitySign(props: { line?: string | undefined }) {
  const live = useAiActivityLine();
  const line = props.line ?? live;
  const said = useAiActivityAnnouncement(line);
  return (
    <div data-slot="ai-activity" className="min-w-0">
      <span aria-live="polite" className="sr-only">
        {said}
      </span>
      {line === undefined ? null : (
        <Link
          to="/settings/ai"
          className="flex min-w-0 justify-center whitespace-nowrap border-b border-line-soft px-4 py-1 text-xs font-semibold hover:bg-page min-[900px]:mx-0.5 min-[900px]:mb-3 min-[900px]:justify-start min-[900px]:rounded-control min-[900px]:border min-[900px]:border-line min-[900px]:px-2.5 min-[900px]:py-1.5 min-[900px]:text-small"
        >
          <SignWords line={line} />
        </Link>
      )}
    </div>
  );
}

// The line's words, cut with an ellipsis when the room runs out, and a run's percent after them,
// such as " · 47%", which always shows.
function SignWords(props: { line: string }) {
  const cut = /^(.*)( · \d+%)$/u.exec(props.line);
  const words = cut?.[1] ?? props.line;
  return (
    <>
      <span className="min-w-0 truncate">
        <StatusText tone="accent">{words}</StatusText>
      </span>
      {cut?.[2] === undefined ? null : (
        <span className="shrink-0 whitespace-pre text-accent">{cut[2]}</span>
      )}
    </>
  );
}
