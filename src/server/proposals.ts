import type { Database } from "../db/index.ts";
import {
  acceptProposal,
  type Proposal,
  skipProposal,
  undoableProposals,
  undoProposal,
} from "../proposals/index.ts";
import type { ProposalRoutes, ProposalView } from "./proposals-views.ts";

// The Proposal routes (spec 08, Proposals; Lifecycle): Accept, "Save and accept" after an Edit,
// Skip, and Undo, through the proposals module. None of them makes an AI call.

export function proposalView(proposal: Proposal): ProposalView {
  return { ...proposal, createdAt: proposal.createdAt.toISOString() };
}

export function proposalRoutes(database: Database): ProposalRoutes {
  return {
    async undoable() {
      return (await undoableProposals(database)).map(proposalView);
    },
    accept(id, memberId, edit) {
      return acceptProposal(database, { id, memberId, ...(edit === undefined ? {} : { edit }) });
    },
    skip(id, memberId) {
      return skipProposal(database, { id, memberId });
    },
    undo(id, memberId) {
      return undoProposal(database, { id, memberId });
    },
  };
}
