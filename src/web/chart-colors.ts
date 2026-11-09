import type { CategoryGroup } from "../categories/list.ts";

// The charts' colors (spec 07, Charts). Recharts takes colors, not classes, so they live here, not
// in styles.css.

// The boards' chart colors: blue (the accent) for this month, the input-border grey for past months,
// a lighter grey for a tile's trend line, and the muted grey for a Budget's dashed line.
export const FULL_COLOR = "#1D4ED8";
export const MUTED_COLOR = "#C6CBD2";
export const TREND_COLOR = "#9AA3AE";
export const BUDGET_LINE_COLOR = "#5B6470";

// One color per Category group, for stacked bars. Each is a mid tone with a contrast of at least
// 3.5 to 1 against white and against the ink color (#14171C), so it reads in a light and a dark
// theme alike.
export const GROUP_COLORS: Readonly<Record<CategoryGroup, string>> = Object.freeze({
  Bills: "#3B6FD8",
  Shopping: "#0E8A7E",
  Transportation: "#C2770E",
  "Health and care": "#C2457A",
  Leisure: "#7B5CD6",
  Other: "#6B7480",
});
