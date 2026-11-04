import { benchmarkNotice, lastCpiFetch } from "../benchmarks/index.ts";
import type { Database } from "../db/index.ts";
import { switchUpdateCheck, type UpdateStatus, updateStatus } from "../updates/index.ts";
import { APP_VERSION, SOURCE_CODE_LINK } from "../version.ts";
import type { AboutRoutes, UpdateCheckView } from "./about-views.ts";

// The Settings, About routes (spec 07, Settings overview): the version, the "Source code" link,
// the Update check, and the Data sources page's CPI date.

// Where the server serves the browser bundle's third-party notices.
const THIRD_PARTY_NOTICES = "/third-party-notices.txt";

function updateCheckView(status: UpdateStatus): UpdateCheckView {
  return { ...status, checkedAt: status.checkedAt?.toISOString() ?? null };
}

export function aboutRoutes(database: Database): AboutRoutes {
  return {
    async about() {
      const cpiFetchedAt = await lastCpiFetch(database);
      return {
        version: APP_VERSION,
        sourceCode: SOURCE_CODE_LINK,
        thirdPartyNotices: THIRD_PARTY_NOTICES,
        updateCheck: updateCheckView(await updateStatus(database)),
        dataSources: {
          cpiFetchedAt: cpiFetchedAt?.toISOString() ?? null,
          benchmarkNotice: benchmarkNotice() ?? null,
        },
      };
    },

    async switchUpdateCheck(on) {
      return updateCheckView(await switchUpdateCheck(database, on));
    },
  };
}
