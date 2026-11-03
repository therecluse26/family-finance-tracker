// A page whose content comes with its own ticket. It shows only the page's name.
export function Placeholder(props: { title: string }) {
  return (
    <main>
      <h1 className="text-2xl font-semibold">{props.title}</h1>
      <p className="mt-2 text-gray-600">This page is not built yet.</p>
    </main>
  );
}
