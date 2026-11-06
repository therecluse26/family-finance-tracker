import { useEffect, useState } from "react";
import { Link } from "react-router";
import DATA_SOURCES from "../../../../docs/data-sources.md?raw";
import { calendarDateIn, dateLabel } from "../../../format.ts";
import type { AboutView } from "../../../server/about-views.ts";
import { api } from "../../api.ts";
import { Card } from "../../components/Card.tsx";
import { ErrorLine } from "../../components/Fields.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { StatusText } from "../../components/Status.tsx";
import { TEXT_LINK } from "./settings-ui.tsx";

// The Data sources page in Settings, About (spec 05, The Data sources page). It renders the repo's
// docs/data-sources.md, which the build bundles into the app, so the page and the file say the
// same. The page adds what only the running app knows: the date it last fetched the CPI, and the
// sample label while the Benchmark snapshot holds sample numbers.

// The document without its own "# Data sources" title, which the page shows as its heading.
const DOCUMENT = DATA_SOURCES.replace(/^#\s+Data sources\s*\n/, "");

export function cpiFetchText(cpiFetchedAt: string | null, now = new Date()): string {
  if (cpiFetchedAt === null) {
    return "The app has not fetched the CPI from BLS yet. It uses the CPI values shipped with this release.";
  }
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = dateLabel(calendarDateIn(new Date(cpiFetchedAt), zone), calendarDateIn(now, zone));
  return `The app last fetched the CPI from BLS on ${day}.`;
}

export function DataSourcesPage(props: {
  dataSources: AboutView["dataSources"] | undefined;
  now?: Date;
}) {
  const { dataSources } = props;
  return (
    <>
      <div>
        <h2 className="text-heading font-bold">Data sources</h2>
        <p className="mt-1 text-sm">
          <Link className={TEXT_LINK} to="/settings/about">
            Back to About
          </Link>
        </p>
      </div>
      <Card>
        {dataSources?.benchmarkNotice == null ? null : (
          <p className="mb-3 font-semibold" role="status">
            <StatusText tone="serious">{dataSources.benchmarkNotice}</StatusText>
          </p>
        )}
        {dataSources === undefined ? null : (
          <p>{cpiFetchText(dataSources.cpiFetchedAt, props.now)}</p>
        )}
        <div className="mt-2 min-w-0 overflow-x-auto">
          <Markdown text={DOCUMENT} topLevel={2} />
        </div>
      </Card>
    </>
  );
}

export function DataSources() {
  const [dataSources, setDataSources] = useState<AboutView["dataSources"] | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    api.about
      .$get()
      .then(async (res) => {
        if (!res.ok) return setError("The CPI fetch date did not load.");
        setDataSources(((await res.json()) as AboutView).dataSources);
      })
      .catch(() => setError("The server did not answer."));
  }, []);

  return (
    <>
      <DataSourcesPage dataSources={dataSources} />
      <ErrorLine error={error} />
    </>
  );
}
