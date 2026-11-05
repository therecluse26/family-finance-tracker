import type { ProposalEditView, ProposalView } from "../server/proposals-views.ts";
import { api } from "./api.ts";

// A Proposal's card and its requests (spec 07, 1. AI box; spec 08, Proposals): "Accept", "Edit"
// then "Save and accept", "Skip", and Undo. None of them makes an AI call. Each write sends a JSON
// body, even an empty one: the server answers 415 to a write without one. The routes read their
// body themselves, so each body goes in through a separate object.

export const proposalRequests = {
  accept: (id: string) => {
    const accept = { param: { id }, json: {} };
    return api.proposals[":id"].accept.$post(accept);
  },
  edit: (id: string, edit: ProposalEditView) => {
    const saveAndAccept = { param: { id }, json: edit };
    return api.proposals[":id"].edit.$post(saveAndAccept);
  },
  skip: (id: string) => {
    const skip = { param: { id }, json: {} };
    return api.proposals[":id"].skip.$post(skip);
  },
  undo: (id: string) => {
    const undo = { param: { id }, json: {} };
    return api.proposals[":id"].undo.$post(undo);
  },
  undoable: () => api.proposals.undoable.$get(),
};

// The words of a refusal, or undefined when it worked.
async function sent(send: () => Promise<Response>): Promise<string | undefined> {
  let res: Response;
  try {
    res = await send();
  } catch {
    return "The server did not answer.";
  }
  if (res.ok) return undefined;
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}

export const acceptProposal = (id: string) => sent(() => proposalRequests.accept(id));
export const skipProposal = (id: string) => sent(() => proposalRequests.skip(id));
export const undoProposal = (id: string) => sent(() => proposalRequests.undo(id));

// "Save and accept": the Member's Edit, then Accept.
export const saveAndAccept = (id: string, edit: ProposalEditView) =>
  sent(() => proposalRequests.edit(id, edit));

export async function loadUndoable(): Promise<ProposalView[]> {
  const res = await proposalRequests.undoable();
  if (!res.ok) throw new Error(`The Proposals request answered ${res.status}.`);
  return ((await res.json()) as { proposals: ProposalView[] }).proposals;
}
