import { asc } from "drizzle-orm";
import type { Database } from "./client.ts";
import { members } from "./schema.ts";

// Each Member's name and email address, in the order Members joined. The ai module's privacy
// filter names them "Member A", "Member B", and so on in this order (spec 08, Privacy filter).
export async function listMembersByJoinOrder(
  database: Database,
): Promise<{ name: string; email: string }[]> {
  return database
    .select({ name: members.name, email: members.email })
    .from(members)
    .orderBy(asc(members.createdAt), asc(members.id));
}
