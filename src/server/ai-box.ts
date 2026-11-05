import type { AiSettings } from "../ai/index.ts";
import { alertNotes, markAlertNote } from "../anomalies/index.ts";
import type { Database } from "../db/index.ts";
import type { AiBoxGroupName, AiBoxNoteView, AiBoxRoutes, AiBoxView } from "./ai-box-views.ts";

// The dashboard's AI box, "This week" (spec 07, 1. AI box): every current note, in three groups.
// Alert notes come from the anomalies module; the AI provider's status gives the "Set up AI for
// insights" note and the paused line.

const GROUPS: AiBoxGroupName[] = ["Worth acting on", "Heads up", "Good news"];

export function aiBoxRoutes(database: Database, ai: AiSettings | undefined): AiBoxRoutes {
  async function paused(): Promise<Pick<AiBoxView, "setUpAi" | "paused">> {
    const view = await ai?.view();
    if (view === undefined) return { setUpAi: true, paused: null };
    const { status } = view;
    if (status.state === "cost cap") {
      return { setUpAi: false, paused: { reason: "cost cap", until: status.until } };
    }
    if (status.state === "key rejected") {
      return { setUpAi: false, paused: { reason: "key rejected" } };
    }
    return { setUpAi: false, paused: null };
  }

  return {
    async view() {
      // Proposals go before the Alert notes, and Insight cards after them, when they come.
      const notes: (AiBoxNoteView & { group: AiBoxGroupName })[] = (
        await alertNotes(database, new Date())
      ).map((note) => ({
        kind: "Alert note",
        id: note.id,
        createdAt: note.createdAt.toISOString(),
        group: note.group,
        figure: note.figure,
        figureLabel: note.figureLabel,
        about: note.about,
        title: note.title,
        why: note.why,
        nextStep: note.nextStep,
        done: note.done,
      }));
      const groups = GROUPS.flatMap((name) => {
        const inGroup = notes
          .filter((note) => note.group === name)
          .map(({ group, ...note }) => note);
        return inGroup.length === 0 ? [] : [{ name, notes: inGroup }];
      });
      return {
        worthActingOn: notes.filter((note) => note.group === "Worth acting on" && !note.done)
          .length,
        groups,
        ...(await paused()),
      };
    },

    markAlertNote(alertId, memberId, done) {
      return markAlertNote(database, { alertId, memberId, done }, new Date());
    },
  };
}
