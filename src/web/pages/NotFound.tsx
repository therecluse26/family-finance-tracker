import { Link } from "react-router";

export function NotFound() {
  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <Link className="mt-2 inline-block text-blue-700 underline" to="/">
        Go to the dashboard
      </Link>
    </main>
  );
}
