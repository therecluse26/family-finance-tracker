// The main menu and the Settings sections (spec 07, Main menu and Settings overview). Each label is
// a GLOSSARY.md term.

export type MenuItem = { label: string; path: string };

export const MAIN_MENU: readonly MenuItem[] = [
  { label: "Dashboard", path: "/" },
  { label: "Transactions", path: "/transactions" },
  { label: "Chat", path: "/chat" },
  { label: "Reviews", path: "/reviews" },
  { label: "Review list", path: "/review-list" },
  { label: "Settings", path: "/settings" },
];

// The "More" section.
export const MORE_MENU: readonly MenuItem[] = [
  { label: "Budgets", path: "/budgets" },
  { label: "Goals", path: "/goals" },
  { label: "Accounts", path: "/accounts" },
  { label: "Alert list", path: "/alert-list" },
  { label: "Recurring charges", path: "/recurring-charges" },
  { label: "Top Merchants", path: "/top-merchants" },
];

// One section per area. Each path is under /settings/.
export const SETTINGS_SECTIONS: readonly MenuItem[] = [
  { label: "Household", path: "household" },
  { label: "Members", path: "members" },
  { label: "My login", path: "my-login" },
  { label: "Banks", path: "banks" },
  { label: "Categories", path: "categories" },
  { label: "Alerts", path: "alerts" },
  { label: "AI", path: "ai" },
  { label: "Backups and data", path: "backups-and-data" },
  { label: "About", path: "about" },
];
