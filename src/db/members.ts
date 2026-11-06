import { and, asc, count, eq, gt, ne, sql } from "drizzle-orm";
import type { Database, Queries } from "./client.ts";
import { goals, members, pushDevices, removedMembers } from "./schema.ts";

// Each Member in the order they joined, with their label number: the ai module's privacy filter
// names number 0 "Member A", number 1 "Member B", and so on (spec 08, Privacy filter). The numbers
// follow the join order and skip every removed Member's number, so a removal changes no other
// Member's label.
async function listNumberedMembers(
  database: Queries,
): Promise<{ id: string; name: string; email: string; labelNumber: number }[]> {
  const all = await database
    .select({ id: members.id, name: members.name, email: members.email })
    .from(members)
    .orderBy(asc(members.createdAt), asc(members.id));
  const removed = await database
    .select({ labelNumber: removedMembers.labelNumber })
    .from(removedMembers);
  const taken = new Set(removed.map(({ labelNumber }) => labelNumber));
  let next = 0;
  return all.map((member) => {
    while (taken.has(next)) next++;
    return { ...member, labelNumber: next++ };
  });
}

// Each Member's name, email address and label number, in the order Members joined.
export async function listMembersByJoinOrder(
  database: Database,
): Promise<{ name: string; email: string; labelNumber: number }[]> {
  return (await listNumberedMembers(database)).map(({ name, email, labelNumber }) => ({
    name,
    email,
    labelNumber,
  }));
}

// Each Member's ID, name and label number, so a page can name the Member who wrote something.
export async function listMemberNamesById(
  database: Database,
): Promise<{ id: string; name: string; labelNumber: number }[]> {
  return (await listNumberedMembers(database)).map(({ id, name, labelNumber }) => ({
    id,
    name,
    labelNumber,
  }));
}

// The first Member: the one who made their login in the first-run wizard's step 2, and so the
// only one who goes through the wizard (spec 12, Order and resume rules). They hold label number
// 0. Once they are removed, number 0 is never given again, so a Member who joined by invite never
// becomes the first Member. Undefined then.
export async function readFirstMemberId(database: Database): Promise<string | undefined> {
  return (await listNumberedMembers(database)).find(({ labelNumber }) => labelNumber === 0)?.id;
}

// Each removed Member's label number and name, so AI text from before the removal shows the name.
export async function listRemovedMembers(
  database: Database,
): Promise<{ labelNumber: number; name: string }[]> {
  return database
    .select({ labelNumber: removedMembers.labelNumber, name: removedMembers.name })
    .from(removedMembers)
    .orderBy(asc(removedMembers.labelNumber));
}

// Every Member, in the order they joined, as Settings, Members list them.
export async function listMembers(
  database: Database,
): Promise<{ id: string; name: string; email: string; createdAt: Date }[]> {
  return database
    .select({
      id: members.id,
      name: members.name,
      email: members.email,
      createdAt: members.createdAt,
    })
    .from(members)
    .orderBy(asc(members.createdAt), asc(members.id));
}

export type MemberRemoval = "removed" | "no such Member" | "last Member";

// Thrown inside the removal's transaction to undo it.
class LastMember extends Error {}

// Removes a Member, in one transaction (spec 09, Members). Their Goals keep their name, their label
// number and name are kept for AI text that names them, and their devices leave web push. Deleting
// the row deletes their sessions, password, TOTP, backup codes, Alert channels and open invite
// links with it. Every other row that names them stays, with no Member. The delete itself refuses
// the last Member, so two removals at once never leave none, and a refusal changes nothing.
export async function removeMember(
  database: Database,
  id: string,
  at: Date,
): Promise<MemberRemoval> {
  try {
    return await database.transaction(async (tx) => {
      const member = (await listNumberedMembers(tx)).find((one) => one.id === id);
      if (member === undefined) return "no such Member";
      await tx.update(goals).set({ authorName: member.name }).where(eq(goals.authorId, id));
      await tx
        .insert(removedMembers)
        .values({ labelNumber: member.labelNumber, name: member.name, removedAt: at });
      await tx.delete(pushDevices).where(eq(pushDevices.memberId, id));
      const others = tx.select({ count: count() }).from(members).where(ne(members.id, id));
      const removed = await tx
        .delete(members)
        .where(and(eq(members.id, id), gt(sql`(${others})`, 0)))
        .returning({ id: members.id });
      if (removed.length === 0) throw new LastMember();
      return "removed" as const;
    });
  } catch (error) {
    if (error instanceof LastMember) return "last Member";
    throw error;
  }
}
