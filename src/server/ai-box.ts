import type { AiSettings } from "../ai/index.ts";
import { alertNotes, markAlertNote } from "../anomalies/index.ts";
import type { Database } from "../db/index.ts";
import { markReviewLink, reviewLinks } from "../monthly-review/index.ts";
import { openProposals } from "../proposals/index.ts";
import type {
  AiBoxGroupName,
  AiBoxNoteView,
  AiBoxProposalView,
  AiBoxReviewLinkView,
  AiBoxRoutes,
  AiBoxView,
} from "./ai-box-views.ts";
import { proposalView } from "./proposals.ts";

// The dashboard's AI box, "This week" (spec 07, 1. AI box): every current note, in three groups.
// Open Proposals come from the proposals module, Alert notes from the anomalies module, and the
// Monthly review's link from the monthly-review module; the AI
// provider's status gives the "Set up AI for insights" note and the paused line.

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
      const now = new Date();
      // Open Proposals go first in "Worth acting on", newest first.
      const proposals: AiBoxProposalView[] = (await openProposals(database, now)).map(
        (proposal) => {
          const view = proposalView(proposal);
          return { kind: "Proposal", id: view.id, createdAt: view.createdAt, proposal: view };
        },
      );
      // Insight cards go after the Alert notes, when they come.
      const notes: (AiBoxNoteView & { group: AiBoxGroupName })[] = (
        await alertNotes(database, now)
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
      // The review link is a Heads up note.
      const links: AiBoxReviewLinkView[] = (await reviewLinks(database, now)).map((link) => ({
        kind: "Review link",
        id: link.month,
        createdAt: link.writtenAt.toISOString(),
      }));
      const groups = GROUPS.flatMap((name) => {
        const inGroup = [
          ...(name === "Worth acting on" ? proposals : []),
          ...notes.filter((note) => note.group === name).map(({ group, ...note }) => note),
          ...(name === "Heads up" ? links : []),
        ];
        return inGroup.length === 0 ? [] : [{ name, notes: inGroup }];
      });
      return {
        worthActingOn:
          proposals.length +
          notes.filter((note) => note.group === "Worth acting on" && !note.done).length,
        groups,
        ...(await paused()),
      };
    },

    markAlertNote(alertId, memberId, done) {
      return markAlertNote(database, { alertId, memberId, done }, new Date());
    },

    markReviewLink(month, memberId, done) {
      return markReviewLink(database, { month, memberId, done }, new Date());
    },
  };
}
