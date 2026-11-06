import type { Auth } from "../auth/index.ts";
import {
  cancelInvite,
  type Database,
  listMembers,
  listOpenInvites,
  removeMember,
} from "../db/index.ts";
import type { AppUrl } from "./app-url.ts";
import type { MemberRemovalResult, MemberRoutes } from "./members-views.ts";
import { readSetupState } from "./setup.ts";

// Settings, Members (spec 09, Members; Invites; Login reset): the Members, the open invite links,
// making and cancelling one, removing a Member, and resetting another Member's login.
export function memberRoutes(database: Database, auth: Auth, appUrl: AppUrl): MemberRoutes {
  // Removes Members one at a time, so the check that another Member stays and the removal run
  // together. The app is one Node process (ADR 0002), so this queue covers every request.
  let queue: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work);
    queue = run.catch(() => {});
    return run;
  };

  return {
    async members(you) {
      const now = new Date();
      const [all, open] = await Promise.all([
        listMembers(database),
        listOpenInvites(database, now),
      ]);
      return {
        members: all.map((member) => ({
          id: member.id,
          name: member.name,
          email: member.email,
          joinedAt: member.createdAt.toISOString(),
          you: member.id === you,
        })),
        invites: open.map((invite) => ({
          id: invite.id,
          madeBy: invite.madeBy,
          createdAt: invite.createdAt.toISOString(),
          expiresAt: invite.expiresAt.toISOString(),
        })),
      };
    },

    async makeInvite(madeBy) {
      if ((await readSetupState(database)).wizard) return "wizard not done";
      const { token, expiresAt } = await auth.makeInvite(madeBy, new Date());
      return { link: appUrl.address(`/join#token=${token}`), expiresAt: expiresAt.toISOString() };
    },

    cancelInvite: (id) => cancelInvite(database, id, new Date()),

    // The row goes first, in one transaction that also deletes the Member's sessions, password,
    // TOTP and backup codes, so they are signed out the moment they stop being a Member, and a
    // failure leaves them a Member with every login part. The hook then deletes what no foreign
    // key ties to the row, such as a TOTP secret waiting for its first code. If it fails, the
    // Member is still gone, and what is left belongs to no one.
    remove: (id) =>
      oneAtATime(async (): Promise<MemberRemovalResult> => {
        const removal = await removeMember(database, id, new Date());
        if (removal === "removed") await auth.removeLogin(id);
        return removal;
      }),

    async resetLogin(id) {
      const reset = await auth.resetLogin(id, new Date());
      if (reset === undefined) return "no such Member";
      return {
        link: appUrl.address(`/reset#token=${reset.token}`),
        expiresAt: reset.expiresAt.toISOString(),
      };
    },
  };
}
