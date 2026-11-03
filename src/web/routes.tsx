import type { RouteObject } from "react-router";
import { MAIN_MENU, MORE_MENU, SETTINGS_SECTIONS } from "./menu.ts";
import { Dashboard } from "./pages/Dashboard.tsx";
import { NotFound } from "./pages/NotFound.tsx";
import { Placeholder } from "./pages/Placeholder.tsx";
import { Setup } from "./pages/Setup.tsx";
import { SignIn } from "./pages/SignIn.tsx";
import { BackupsAndData } from "./pages/settings/BackupsAndData.tsx";
import { Banks } from "./pages/settings/Banks.tsx";
import { MyLogin } from "./pages/settings/MyLogin.tsx";
import { Settings, SettingsIndex, SettingsPlaceholder } from "./pages/settings/Settings.tsx";
import { Shell } from "./Shell.tsx";

// Every page route. Each main menu item and each Settings section has its own route. A page whose
// content comes with a later ticket shows a placeholder.

const BUILT_SECTIONS: Record<string, () => React.JSX.Element> = {
  "my-login": MyLogin,
  banks: Banks,
  "backups-and-data": BackupsAndData,
};

const settingsSections: RouteObject[] = SETTINGS_SECTIONS.map((section) => {
  const Section = BUILT_SECTIONS[section.path];
  return {
    path: section.path,
    element: Section === undefined ? <SettingsPlaceholder title={section.label} /> : <Section />,
  };
});

const pages: RouteObject[] = [...MAIN_MENU, ...MORE_MENU]
  .filter((item) => item.path !== "/settings")
  .map((item) =>
    item.path === "/"
      ? { index: true, element: <Dashboard /> }
      : { path: item.path.slice(1), element: <Placeholder title={item.label} /> },
  );

export const routes: RouteObject[] = [
  { path: "/setup", Component: Setup },
  { path: "/sign-in", Component: SignIn },
  {
    path: "/",
    Component: Shell,
    children: [
      ...pages,
      {
        path: "settings",
        Component: Settings,
        children: [{ index: true, Component: SettingsIndex }, ...settingsSections],
      },
      { path: "*", Component: NotFound },
    ],
  },
];
