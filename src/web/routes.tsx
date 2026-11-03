import type { RouteObject } from "react-router";
import { MAIN_MENU, MORE_MENU, SETTINGS_SECTIONS } from "./menu.ts";
import { NotFound } from "./pages/NotFound.tsx";
import { Placeholder } from "./pages/Placeholder.tsx";
import { Setup } from "./pages/Setup.tsx";
import { SignIn } from "./pages/SignIn.tsx";
import { MyLogin } from "./pages/settings/MyLogin.tsx";
import { Settings, SettingsIndex, SettingsPlaceholder } from "./pages/settings/Settings.tsx";
import { Shell } from "./Shell.tsx";

// Every page route. Each main menu item and each Settings section has its own route. A page whose
// content comes with a later ticket shows a placeholder.

const settingsSections: RouteObject[] = SETTINGS_SECTIONS.map((section) => ({
  path: section.path,
  element:
    section.path === "my-login" ? <MyLogin /> : <SettingsPlaceholder title={section.label} />,
}));

const pages: RouteObject[] = [...MAIN_MENU, ...MORE_MENU]
  .filter((item) => item.path !== "/settings")
  .map((item) =>
    item.path === "/"
      ? { index: true, element: <Placeholder title={item.label} /> }
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
