import { Navigate, type RouteObject } from "react-router";
import { MAIN_MENU, MORE_MENU, SETTINGS_SECTIONS } from "./menu.ts";
import { Accounts } from "./pages/Accounts.tsx";
import { AlertList } from "./pages/AlertList.tsx";
import { Budgets } from "./pages/Budgets.tsx";
import { Chat } from "./pages/Chat.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Goals } from "./pages/Goals.tsx";
import { Join } from "./pages/Join.tsx";
import { NotFound } from "./pages/NotFound.tsx";
import { Placeholder } from "./pages/Placeholder.tsx";
import { RecurringCharges } from "./pages/RecurringCharges.tsx";
import { Reports } from "./pages/Reports.tsx";
import { Reset } from "./pages/Reset.tsx";
import { ReviewList } from "./pages/ReviewList.tsx";
import { MonthlyReviewPage, Reviews } from "./pages/Reviews.tsx";
import { Setup } from "./pages/Setup.tsx";
import { SignIn } from "./pages/SignIn.tsx";
import { About } from "./pages/settings/About.tsx";
import { Ai } from "./pages/settings/Ai.tsx";
import { AiRequestLog, AiRequestLogEntry } from "./pages/settings/AiRequestLog.tsx";
import { AiUsage } from "./pages/settings/AiUsage.tsx";
import { Alerts } from "./pages/settings/Alerts.tsx";
import { BackupsAndData } from "./pages/settings/BackupsAndData.tsx";
import { Banks } from "./pages/settings/Banks.tsx";
import { Categories } from "./pages/settings/Categories.tsx";
import { DataSources } from "./pages/settings/DataSources.tsx";
import { Household } from "./pages/settings/Household.tsx";
import { Members } from "./pages/settings/Members.tsx";
import { MyLogin } from "./pages/settings/MyLogin.tsx";
import { PriceSources } from "./pages/settings/PriceSources.tsx";
import { Settings, SettingsIndex, SettingsPlaceholder } from "./pages/settings/Settings.tsx";
import { StoreOrders } from "./pages/settings/StoreOrders.tsx";
import { TopMerchants } from "./pages/TopMerchants.tsx";
import { TransactionDetail } from "./pages/TransactionDetail.tsx";
import { Transactions } from "./pages/Transactions.tsx";
import { Shell } from "./Shell.tsx";

// Every page route. Each main menu item and each Settings section has its own route. A page whose
// content comes with a later ticket shows a placeholder.

const BUILT_SECTIONS: Record<string, () => React.JSX.Element> = {
  household: Household,
  members: Members,
  "my-login": MyLogin,
  banks: Banks,
  categories: Categories,
  "store-orders": StoreOrders,
  "price-sources": PriceSources,
  alerts: Alerts,
  "backups-and-data": BackupsAndData,
  ai: Ai,
  about: About,
};

const settingsSections: RouteObject[] = SETTINGS_SECTIONS.map((section) => {
  const Section = BUILT_SECTIONS[section.path];
  return {
    path: section.path,
    element: Section === undefined ? <SettingsPlaceholder title={section.label} /> : <Section />,
  };
});

const BUILT_PAGES: Record<string, () => React.JSX.Element> = {
  "/accounts": Accounts,
  "/alert-list": AlertList,
  "/budgets": Budgets,
  "/chat": Chat,
  "/goals": Goals,
  "/recurring-charges": RecurringCharges,
  "/reports": Reports,
  "/review-list": ReviewList,
  "/reviews": Reviews,
  "/top-merchants": TopMerchants,
  "/transactions": Transactions,
};

const pages: RouteObject[] = [...MAIN_MENU, ...MORE_MENU]
  .filter((item) => item.path !== "/settings")
  .map((item) => {
    if (item.path === "/") return { index: true, element: <Dashboard /> };
    const Page = BUILT_PAGES[item.path];
    return {
      path: item.path.slice(1),
      element: Page === undefined ? <Placeholder title={item.label} /> : <Page />,
    };
  });

export const routes: RouteObject[] = [
  { path: "/setup", Component: Setup },
  { path: "/sign-in", Component: SignIn },
  // An invite link's page, outside the app's own pages: it never leads to the wizard.
  { path: "/join", Component: Join },
  // A reset link's page, outside the app's own pages, for a Member who cannot sign in.
  { path: "/reset", Component: Reset },
  {
    path: "/",
    Component: Shell,
    children: [
      ...pages,
      // An Account's page, opened from the Account list. It loads with its chart library, apart
      // from the rest of the app.
      {
        path: "accounts/:id",
        lazy: async () => ({ Component: (await import("./pages/Account.tsx")).Account }),
      },
      // A Transaction's detail view, opened from the Transactions page.
      { path: "transactions/:id", Component: TransactionDetail },
      // One month's Monthly review, opened from the Reviews page or the AI box's review link.
      { path: "reviews/:month", Component: MonthlyReviewPage },
      // A Chat thread, opened from the Chat page.
      { path: "chat/:id", Component: Chat },
      {
        path: "settings",
        Component: Settings,
        children: [
          { index: true, Component: SettingsIndex },
          ...settingsSections,
          // The AI usage page, linked from Settings → AI.
          { path: "ai/usage", Component: AiUsage },
          // The AI request log and one kept call, linked from the AI usage page.
          { path: "ai/usage/log", Component: AiRequestLog },
          { path: "ai/usage/log/:id", Component: AiRequestLogEntry },
          // The Data sources page, linked from Settings → About.
          { path: "about/data-sources", Component: DataSources },
          // Store orders' old address, from when Amazon was its own tab. The address is replaced.
          { path: "amazon", element: <Navigate to="/settings/store-orders" replace /> },
        ],
      },
      { path: "*", Component: NotFound },
    ],
  },
];
