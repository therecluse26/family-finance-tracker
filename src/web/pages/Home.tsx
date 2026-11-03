import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api.ts";

type ServerState = "checking" | "running" | "down";

const STATUS_TEXT: Record<ServerState, string> = {
  checking: "Checking the server…",
  running: "The server is running.",
  down: "The server did not answer.",
};

export function Home() {
  const navigate = useNavigate();
  const [state, setState] = useState<ServerState>("checking");

  useEffect(() => {
    api.ping
      .$get()
      .then(async (res) => {
        if (res.status === 401) return navigate("/sign-in", { replace: true });
        const body = await res.json();
        setState(body.ok ? "running" : "down");
      })
      .catch(() => setState("down"));
  }, [navigate]);

  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-semibold">Family Finance Tracker</h1>
      <p className="mt-2 text-gray-600">{STATUS_TEXT[state]}</p>
    </main>
  );
}
