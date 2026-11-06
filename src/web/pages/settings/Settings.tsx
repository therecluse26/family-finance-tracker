import { NavLink, Outlet } from "react-router";
import { Page, PageHeading } from "../../components/Page.tsx";
import { SETTINGS_SECTIONS } from "../../menu.ts";
import { TabHeading } from "./settings-ui.tsx";

// Settings: one section per area (spec 07, Settings overview), as a row of tabs under the heading.
export function Settings() {
  return (
    <Page>
      <PageHeading title="Settings" />
      <nav aria-label="Settings sections" className="-mt-0.5 border-b border-line">
        <ul className="flex flex-wrap gap-x-1">
          {SETTINGS_SECTIONS.map((section) => (
            <li key={section.path}>
              <NavLink
                to={section.path}
                className="-mb-px block border-b-2 border-transparent px-3 py-2.5 text-sm text-ink-soft hover:text-ink aria-[current=page]:border-accent aria-[current=page]:font-semibold aria-[current=page]:text-ink"
              >
                {section.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="mt-1 flex min-w-0 flex-col gap-4">
        <Outlet />
      </div>
    </Page>
  );
}

// A Settings section whose content comes with its own ticket.
export function SettingsPlaceholder(props: { title: string }) {
  return (
    <>
      <TabHeading>{props.title}</TabHeading>
      <p className="text-muted">This section is not built yet.</p>
    </>
  );
}

// Settings before a section is chosen.
export function SettingsIndex() {
  return <p className="text-muted">Choose a section.</p>;
}
