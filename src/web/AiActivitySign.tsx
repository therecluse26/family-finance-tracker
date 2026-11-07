import { Link } from "react-router";
import { useAiActivityLine } from "./ai-activity.ts";
import { StatusText } from "./components/Status.tsx";

// The live AI status in the main menu (spec 07, Main menu; spec 08, Live AI status): "● AI
// working: Categories" while background AI works, linked to Settings, AI. The live region is always
// there, so a screen reader reads each new line; with no work it is empty and takes no room.
// From 900 px wide it sits in the menu column under the app's name. At phone width it is a thin
// line at the top of the bar at the foot of the screen; the open menu shows it under the app's name.
export function AiActivitySign(props: { line?: string | undefined }) {
  const live = useAiActivityLine();
  const line = props.line ?? live;
  return (
    <div aria-live="polite" data-slot="ai-activity" className="min-w-0">
      {line === undefined ? null : (
        <Link
          to="/settings/ai"
          className="block truncate border-b border-line-soft px-4 py-1 text-center text-xs font-semibold hover:bg-page min-[900px]:mx-0.5 min-[900px]:mb-3 min-[900px]:rounded-control min-[900px]:border min-[900px]:border-line min-[900px]:px-2.5 min-[900px]:py-1.5 min-[900px]:text-left min-[900px]:text-small"
        >
          <StatusText tone="accent">{line}</StatusText>
        </Link>
      )}
    </div>
  );
}
