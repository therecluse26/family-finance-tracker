import { NoticeLines } from "../components/NoticeLines.tsx";

// The dashboard (spec 07). This ticket brings the System notice lines above its boxes. The header
// and the boxes come with their own tickets.
export function Dashboard() {
  return (
    <main>
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <NoticeLines />
      <p className="mt-4 text-gray-600">The dashboard's boxes are not built yet.</p>
    </main>
  );
}
