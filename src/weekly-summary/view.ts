// The weekly summary email's switch, as Settings, Alerts sees it (spec 06, Weekly summary email).
// This file imports nothing, so the web app's type check can follow it.

export type WeeklySummaryView = {
  // The signed-in Member's own switch. Off until they turn it on.
  on: boolean;
  // False while no SMTP server is saved: the app sends no summary.
  emailSetUp: boolean;
  // The Member's latest summary that ended: its 7 days, whether it was sent or given up, and the
  // Household's date when it ended. Null before the first.
  last: { from: string; to: string; state: "sent" | "gave up"; on: string } | null;
};

export type WeeklySummarySettings = {
  view(memberId: string): Promise<WeeklySummaryView>;
  set(memberId: string, on: boolean): Promise<WeeklySummaryView>;
};
