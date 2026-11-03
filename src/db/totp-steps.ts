import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { Database } from "./client.ts";
import { twoFactors } from "./schema.ts";

// Marks a Member's TOTP time step as used, in one statement. It is true only when the step is
// later than every step used before, so of two requests with the same code, only one gets true.
export async function claimTotpStep(
  database: Database,
  memberId: string,
  step: number,
): Promise<boolean> {
  const claimed = await database
    .update(twoFactors)
    .set({ lastTotpStep: step })
    .where(
      and(
        eq(twoFactors.userId, memberId),
        or(isNull(twoFactors.lastTotpStep), lt(twoFactors.lastTotpStep, step)),
      ),
    )
    .returning({ id: twoFactors.id });
  return claimed.length === 1;
}
