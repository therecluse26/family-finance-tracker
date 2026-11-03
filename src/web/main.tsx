import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { Home } from "./pages/Home.tsx";
import { NotFound } from "./pages/NotFound.tsx";
import { SignIn } from "./pages/SignIn.tsx";
import "./styles.css";

const router = createBrowserRouter([
  { path: "/", Component: Home },
  { path: "/sign-in", Component: SignIn },
  { path: "*", Component: NotFound },
]);

const root = document.getElementById("root");
if (!root) throw new Error("The page has no #root element.");

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
