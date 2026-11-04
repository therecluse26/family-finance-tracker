import { connectionToRepair } from "../bank/index.ts";
import { closeEventNotice, type Database, listOpenNotices } from "../db/index.ts";
import type { NoticeRoutes } from "./notice-views.ts";

// The System notice routes' reads and writes in app.db.
export function noticeRoutes(database: Database): NoticeRoutes {
  return {
    async open() {
      return (await listOpenNotices(database)).map((notice) => ({
        id: notice.id,
        text: notice.text,
        raisedAt: notice.raisedAt.toISOString(),
        closable: notice.kind === "event",
        repairConnectionId: connectionToRepair(notice.condition),
      }));
    },

    close(id, memberId) {
      return closeEventNotice(database, id, memberId, new Date());
    },
  };
}
