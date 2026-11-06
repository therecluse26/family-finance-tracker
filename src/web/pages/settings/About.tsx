import { useEffect, useState } from "react";
import { Link } from "react-router";
import { calendarDateIn, dateLabel } from "../../../format.ts";
import type { AboutView, UpdateCheckView } from "../../../server/about-views.ts";
import { api } from "../../api.ts";
import { ErrorLine } from "../../components/Fields.tsx";
import { useHouseholdZone } from "../../household-zone.ts";

// Settings, About (spec 07, Settings overview; spec 12, Updates): the version, the "Source code"
// link to that exact version, the third-party notices, the Data sources page, "Update available",
// and the Update check's switch.

const LINK = "text-blue-700 underline";

// "Nov 4", or "Nov 4, 2025" in another year, in `zone`, the Household time zone.
function dayLabel(at: string, zone: string, now: Date): string {
  return dateLabel(calendarDateIn(new Date(at), zone), calendarDateIn(now, zone));
}

const FAILURE_WORDS: Record<string, string> = {
  "timed out": "GitHub did not answer in time",
  unreachable: "the app could not reach GitHub",
  "rate limited": "GitHub asked the app to wait",
  refused: "GitHub refused the request",
  "bad answer": "GitHub's answer named no release the app can read",
};

export function UpdateLines(props: { check: UpdateCheckView; zone: string; now?: Date }) {
  const { check, zone } = props;
  const now = props.now ?? new Date();
  if (!check.on) return <p className="mt-2">The Update check is off.</p>;
  const { update } = check;
  return (
    <>
      {update === null ? (
        <p className="mt-2">
          {check.checkedAt === null
            ? "The app has not checked for an update yet."
            : `No update. The app last checked on ${dayLabel(check.checkedAt, zone, now)}.`}
        </p>
      ) : (
        <div className="mt-2" role="status">
          <p>
            <strong>Update available</strong>: version {update.version}.
          </p>
          {update.newMajor ? (
            <p className="mt-1">
              This is a new major version. Change the image version in compose.yaml from :
              {update.imageMajor.now} to :{update.imageMajor.update}, then update.{" "}
              <a className={LINK} href={update.releaseNotes} rel="noreferrer">
                Read the release notes
              </a>{" "}
              first.
            </p>
          ) : null}
        </div>
      )}
      {check.lastFailure === null ? null : (
        <p className="mt-1 text-gray-600">
          The last check failed: {FAILURE_WORDS[check.lastFailure] ?? check.lastFailure}. The app
          tries again tomorrow.
        </p>
      )}
    </>
  );
}

export function AboutDetails(props: {
  about: AboutView;
  zone: string;
  busy?: boolean;
  onSwitch?: (on: boolean) => void;
  now?: Date;
}) {
  const { about } = props;
  return (
    <>
      <p className="mt-4">Version {about.version}</p>
      <ul className="mt-2 space-y-1">
        <li>
          <a className={LINK} href={about.sourceCode} rel="noreferrer">
            Source code
          </a>{" "}
          for this exact version, under the GNU AGPL
        </li>
        <li>
          <a className={LINK} href={about.thirdPartyNotices}>
            Third-party notices
          </a>
        </li>
        <li>
          <Link className={LINK} to="/settings/about/data-sources">
            Data sources
          </Link>{" "}
          for the Benchmarks
        </li>
      </ul>
      <h3 className="mt-6 font-semibold">Updates</h3>
      <UpdateLines check={about.updateCheck} zone={props.zone} now={props.now} />
      <label className="mt-3 flex items-center gap-2">
        <input
          type="checkbox"
          checked={about.updateCheck.on}
          disabled={props.busy === true}
          onChange={(event) => props.onSwitch?.(event.target.checked)}
        />
        Check GitHub for a newer release once a day
      </label>
      <p className="mt-1 text-gray-600">
        The check sends no Household data. Off, the app makes no request.
      </p>
    </>
  );
}

export function About() {
  const [about, setAbout] = useState<AboutView | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const zone = useHouseholdZone();

  useEffect(() => {
    api.about
      .$get()
      .then(async (res) => {
        if (!res.ok) return setError("The About details did not load.");
        setAbout((await res.json()) as AboutView);
      })
      .catch(() => setError("The server did not answer."));
  }, []);

  function switchCheck(on: boolean) {
    setBusy(true);
    setError(undefined);
    api.about["update-check"]
      .$put({ json: { on } })
      .then(async (res) => {
        if (!res.ok) return setError("The switch did not save.");
        const { updateCheck } = (await res.json()) as { updateCheck: UpdateCheckView };
        setAbout((shown) => (shown === undefined ? shown : { ...shown, updateCheck }));
      })
      .catch(() => setError("The server did not answer."))
      .finally(() => setBusy(false));
  }

  return (
    <>
      <h2 className="text-xl font-semibold">About</h2>
      {about === undefined || zone === undefined ? null : (
        <AboutDetails about={about} zone={zone} busy={busy} onSwitch={switchCheck} />
      )}
      <ErrorLine error={error} />
    </>
  );
}
