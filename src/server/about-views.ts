// What the Settings, About routes answer. This file imports nothing, so the web app's type check
// can follow it through api.ts.

export type UpdateCheckView = {
  // Any Member may turn the check off. Off, the app makes no request and shows no update.
  on: boolean;
  // When GitHub last answered a check, or null.
  checkedAt: string | null;
  // A newer release than the running version, or null.
  update: {
    version: string;
    // A new major version: the image version in compose.yaml must change, from `now` to `update`.
    newMajor: boolean;
    imageMajor: { now: number; update: number };
    releaseNotes: string;
  } | null;
  // Why the last check failed, such as "rate limited", or null.
  lastFailure: string | null;
};

export type AboutView = {
  version: string;
  // The "Source code" link to this exact version.
  sourceCode: string;
  // The browser bundle's third-party notices.
  thirdPartyNotices: string;
  updateCheck: UpdateCheckView;
  // The Data sources page's live parts: the date the app last fetched the CPI, or null, and the
  // label a sample Benchmark snapshot carries, or null for the real one.
  dataSources: { cpiFetchedAt: string | null; benchmarkNotice: string | null };
};

export type AboutRoutes = {
  about(): Promise<AboutView>;
  switchUpdateCheck(on: boolean): Promise<UpdateCheckView>;
};
