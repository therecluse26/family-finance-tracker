// The open System notices, one status line each, above the dashboard's boxes (spec 07, Header and
// status lines). An event notice has a close button, which closes it for every Member. A condition
// notice stays until its condition ends. The notice of a stopped First run or bank-added-later job
// has a Retry button, which starts it again.

export type NoticeLine = { id: string; text: string; closable: boolean; retry?: boolean };

export function NoticeList(props: {
  notices: NoticeLine[];
  onClose: (id: string) => void;
  onRetry?: () => void;
}) {
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
          {notice.retry === true && props.onRetry !== undefined ? (
            <button type="button" className="text-blue-800 underline" onClick={props.onRetry}>
              Retry
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
