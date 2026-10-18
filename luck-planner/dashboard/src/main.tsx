/**
 * Browser entry point of the dashboard (PLAN.md stage G1).
 *
 * Bundled by `scripts/bundle.mjs` into `dist/dashboard/assets/dashboard.js`
 * and loaded by `dist/dashboard/index.html`. Two jobs only: mount the app on
 * `#root`, and keep the stylesheet import here so esbuild emits
 * `assets/dashboard.css` next to the script — one build step, one asset pair.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./dashboard.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("luck-planner dashboard: #root is missing from index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
