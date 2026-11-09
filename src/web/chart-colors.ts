import type { CategoryGroup } from "../categories/list.ts";

// The charts' colors (spec 07, Charts). Recharts takes colors, not classes, so they live here, not
// in styles.css.

// The boards' chart colors: blue (the accent) for this month, the input-border grey for past months,
// a lighter grey for a tile's trend line, and the muted grey for a Budget's dashed line.
export const FULL_COLOR = "#1D4ED8";
export const MUTED_COLOR = "#C6CBD2";
export const TREND_COLOR = "#9AA3AE";
export const BUDGET_LINE_COLOR = "#5B6470";

// The Reports page's chart frame, as the styles.css tokens: grid lines (line-soft), axis words
// (muted), the white card under a chart, and the ink color for a line that sums the others.
export const GRID_COLOR = "#EEF0F2";
export const AXIS_TEXT_COLOR = "#5B6470";
export const SURFACE_COLOR = "#FFFFFF";
export const INK_COLOR = "#14171C";
// The current month is drawn pale, as "so far": its bars at this opacity.
export const SO_FAR_OPACITY = 0.4;

// One color per Category group, for stacked bars. Each is a mid tone with a contrast of at least
// 3.5 to 1 against white and against the ink color (#14171C), so it reads in a light and a dark
// theme alike. The five hues pass the dataviz palette checks (lightness band, chroma floor,
// colorblind and normal-vision separation, contrast) on white and on the ink color; "Other" is
// grey on purpose.
export const GROUP_COLORS: Readonly<Record<CategoryGroup, string>> = Object.freeze({
  Bills: "#3B6FD8",
  Shopping: "#0A9182",
  Transportation: "#C2770E",
  "Health and care": "#C2457A",
  Leisure: "#7B5CD6",
  Other: "#6B7480",
});
