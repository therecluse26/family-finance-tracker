// The browser's own time zone, for "today" and for when a Connection last synced. It holds no JSX,
// so the dashboard's requests, which the server's tests run, can use it too.
export const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
