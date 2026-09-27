/* Final acceptance probe: uses the plugin's own bridge modules (via vitest's
 * esbuild transform isn't available here, so this replicates the bridge calls
 * through the same DaemonClient config the bridge uses). */
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
let listen = null;
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf-8"));
  if (typeof cfg?.daemon?.listen === "string") listen = cfg.daemon.listen;
} catch {}
const m = listen?.match(/^(.+?):(\d{1,5})$/) ?? [];
const url = `ws://${m[1] ?? "127.0.0.1"}:${m[2] ?? "6767"}/ws`;

const client = new DaemonClient({ url, clientId: "cid_probe_bridge_check", clientType: "cli", suppressSendErrors: true });
client.connect();
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("connect timeout")), 5000);
  const check = setInterval(() => {
    if (client.getConnectionState().status === "connected") { clearTimeout(timer); clearInterval(check); resolve(); }
    else if (client.getConnectionState().status === "disconnected") { clearTimeout(timer); clearInterval(check); reject(new Error("disconnected")); }
  }, 100);
});
const list = await client.scheduleList();
console.log(`bridge check OK via ${url}: ${list.schedules.length} schedule(s) on the daemon`);
client.close();
process.exit(0);
