import { useEffect, useState } from "react";
import { api } from "../api.ts";

// The open System notices, one status line each, above the dashboard's boxes (spec 07, Header and
// status lines). An event notice has a close button, which closes it for every Member. A condition
// notice stays until its condition ends.

export type NoticeLine = { id: string; text: string; closable: boolean };

export function NoticeList(props: { notices: NoticeLine[]; onClose: (id: string) => void }) {
  if (props.notices.length === 0) return null;
  return (
    <ul aria-label="System notices" className="mt-4 flex flex-col gap-2">
      {props.notices.map((notice) => (
        <li
          key={notice.id}
          className="flex items-start justify-between gap-3 rounded border border-blue-200 bg-blue-50 px-3 py-2"
        >
          <span>
            <span aria-hidden="true" className="text-blue-700">
              ●{" "}
            </span>
            {notice.text}
          </span>
          {notice.closable ? (
            <button
              type="button"
              className="text-blue-800 underline"
              aria-label={`Close: ${notice.text}`}
              onClick={() => props.onClose(notice.id)}
            >
              Close
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function NoticeLines() {
  const [notices, setNotices] = useState<NoticeLine[]>([]);

  async function read() {
    const res = await api.notices.$get();
    if (res.ok) setNotices((await res.json()).notices);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: read once, when the page opens.
  useEffect(() => {
    read().catch(() => {});
  }, []);

  function close(id: string) {
    api.notices[":id"].close
      .$post({ param: { id } })
      .then(read)
      .catch(() => {});
  }

  return <NoticeList notices={notices} onClose={close} />;
}
