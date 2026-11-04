// The one plain voice (spec 08, The one plain voice). Every AI use writes in it, and there is no
// tone or length setting (spec 13, AI). The fixed rules open every prompt, so they hold nothing
// that changes from call to call. They are the app's own words, never Household data.

export const FIXED_RULES = [
  "You write for a household finance app. Follow these rules in every reply.",
  "- Be plain, direct, and short, like a good accountant. Put the facts first.",
  "- Every sentence carries a number or an action.",
  "- Never moralize or shame. Use no exclamation marks and no emoji.",
  "- Use these words for these things: Budget, Category, Spending, Income, Goal, Recurring charge, Account, Member, Household, Alert.",
  "- Use only the data given. Back every claim with a number. When the data cannot answer, say so.",
  '- Give no generic advice, such as "make a budget", "cut back on non-essentials", or "shop around". Name what to change and by how much.',
  "- Tie advice to an active Goal when it fits, and quote the Goal's own words.",
  '- Do not warn again about anything a Member marked "Not a problem".',
  '- Name a financial product by its kind only, never by company, lender, or card. Give each product idea a line that starts with "Catch:" and names its fees, credit check, promo that ends, or the habit that built the debt.',
  "- Label any rate you assume as assumed.",
].join("\n");

// One emoji: a pictograph or a flag letter, with its skin tone, presentation mark, and keycap
// mark, and any pictographs joined to it. A keycap, such as 1\uFE0F\u20E3, is a digit or # or *
// with its keycap mark.
const PICTOGRAPH = String.raw`(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\p{Emoji_Modifier}|\uFE0F|\u20E3)*`;
const KEYCAP = String.raw`[0-9#*]\uFE0F?\u20E3`;
const EMOJI = String.raw`(?:${KEYCAP}|${PICTOGRAPH}(?:\u200D${PICTOGRAPH})*)`;

// A run of emoji and the spaces around it.
const EMOJI_RUN = new RegExp(String.raw`([ \t]*)(?:${EMOJI}|\uFE0F)+([ \t]*)`, "gu");

// Punctuation that follows a word with no space, such as a full stop or a closing bracket.
const CLOSING = /^[.,;:!?！？)\]}»”’]/u;

// A run of exclamation marks, with any question marks among them.
const EXCLAMATIONS = /[?？]*[!！][!！?？]*/gu;

// AI text before display: with no emoji, and "!" turned into ".". A removed emoji leaves one space
// between words, and none at the start or end of a line or before punctuation; a line's indent
// stays. "?!" keeps its
// question mark.
export function plainVoice(text: string): string {
  return text
    .replace(EMOJI_RUN, (run: string, before: string, after: string, at: number, whole: string) => {
      const lineStart = at === 0 || whole[at - 1] === "\n";
      const end = at + run.length;
      const endOrClosing =
        end === whole.length ||
        whole[end] === "\n" ||
        whole[end] === "\r" ||
        CLOSING.test(whole.slice(end, end + 1));
      if (lineStart) return before;
      if (endOrClosing) return "";
      return before === "" && after === "" ? "" : " ";
    })
    .replace(EXCLAMATIONS, (marks) => (/[?？]/u.test(marks) ? "?" : "."));
}
