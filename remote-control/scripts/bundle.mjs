// Bundle entry point. The console web app is bundled in a later stage.
// For now this only ensures the output directory exists.
import { mkdirSync } from "node:fs";
mkdirSync("dist/console", { recursive: true });