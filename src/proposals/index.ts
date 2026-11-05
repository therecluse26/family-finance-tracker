// The proposals module's interface (spec 08, Proposals). Other modules import from here.
export { namedCompany, US_BANKS_AND_LENDERS } from "./companies.ts";
export {
  type AcceptResult,
  acceptProposal,
  GUARDRAIL,
  MAX_PROPOSALS_PER_RUN,
  openProposals,
  openReviewProposals,
  PROPOSAL_DAYS,
  type Proposal,
  type ProposalEdit,
  type ProposalInput,
  type ProposedBudget,
  type ProposeResult,
  propose,
  skipProposal,
  undoableProposals,
  undoProposal,
} from "./proposals.ts";
