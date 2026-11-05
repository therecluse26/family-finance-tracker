import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { setUpInstall } from "./install.ts";
import { routes } from "./routes.tsx";
import "./styles.css";

setUpInstall(window);

const router = createBrowserRouter(routes);

const root = document.getElementById("root");
if (!root) throw new Error("The page has no #root element.");

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
