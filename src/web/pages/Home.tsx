import { useEffect, useState } from "react";
import { api } from "../api.ts";

type ServerState = "checking" | "running" | "down";

const STATUS_TEXT: Record<ServerState, string> = {
  checking: "Checking the server…",
  running: "The server is running.",
  down: "The server did not answer.",
};

export function Home() {
  const [state, setState] = useState<ServerState>("checking");

  useEffect(() => {
    api.ping
      .$get()
      .then((res) => res.json())
      .then((body) => setState(body.ok ? "running" : "down"))
      .catch(() => setState("down"));
  }, []);

  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-semibold">Family Finance Tracker</h1>
      <p className="mt-2 text-gray-600">{STATUS_TEXT[state]}</p>
    </main>
  );
}
