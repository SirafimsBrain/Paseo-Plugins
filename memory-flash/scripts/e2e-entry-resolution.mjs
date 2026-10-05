/**
 * End-to-end check of the injected MCP entry path.
 *
 * Reproduces the real failure reported from Paseo work — an agent whose
 * config holds an entry path from a plugin revision the daemon has since
 * deleted — and proves that the published, revision-independent entry keeps
 * that agent working across the update.
 *
 * Usage: node scripts/e2e-entry-resolution.mjs
 */
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(root, "dist", "mcp-server.js");

/** Installs `bundle` as plugin revision `revision` inside `home`. */
function installRevision(home, revision) {
  const install = join(home, "plugins", "memory-flash", revision, "checkout", "memory-flash");
  mkdirSync(join(install, "dist"), { recursive: true });
  copyFileSync(bundle, join(install, "dist", "mcp-server.js"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ plugins: { "memory-flash": { source: "directory", path: install } } }),
  );
  return install;
}

/** Resolves the entry exactly as the plugin host does at agent.create time. */
async function resolveEntry(home) {
  const probe = join(home, "probe.mjs");
  await build({
    entryPoints: [join(root, "scripts", "entry-probe.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: probe,
    logLevel: "silent",
  });
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [probe], {
      env: { ...process.env, PASEO_HOME: home },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("exit", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`probe exit ${code}`))));
  });
  return JSON.parse(out);
}

/** Full JSON-RPC handshake against a spawned stdio MCP server. */
function handshake(entry, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, PASEO_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    let serverName;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("handshake timed out"));
    }, 15000);
    const fail = (reason) => {
      clearTimeout(timer);
      child.kill();
      reject(new Error(`${reason}\nstderr: ${stderr}`));
    };
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => fail(`server exited with ${code}`));
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // Not JSON — ignore.
        }
        if (message.id === 1) {
          serverName = message.result?.serverInfo?.name;
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n",
          );
        } else if (message.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve({
            name: serverName,
            tools: message.result?.tools?.length ?? 0,
          });
        }
      }
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "e2e-entry-resolution", version: "1" },
        },
      }) + "\n",
    );
  });
}

const home = mkdtempSync(join(tmpdir(), "mf-e2e-"));
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

try {
  installRevision(home, "rev-a");
  const before = await resolveEntry(home);
  const agentEntry = before.args[0];
  const handshakeBefore = await handshake(agentEntry, home);
  check("agent.create entry answers the MCP handshake", handshakeBefore.tools === 9,
    `${handshakeBefore.tools} tools, server ${handshakeBefore.name}`);
  check("entry path itself is outside the revision directory",
    !agentEntry.includes("rev-a") && realpathSync(agentEntry).includes("rev-a"),
    `${agentEntry} -> ${realpathSync(agentEntry)}`);

  // The daemon deletes the old revision and installs a new one — the step that
  // broke the running agent with `MCP error -32000: Connection closed`.
  rmSync(join(home, "plugins", "memory-flash", "rev-a"), { recursive: true, force: true });
  installRevision(home, "rev-b");

  const after = await resolveEntry(home);
  check("entry path is unchanged across the update", after.args[0] === agentEntry,
    `${after.args[0]}`);
  check("entry still points at the new revision",
    realpathSync(after.args[0]).includes("rev-b"));

  // The decisive check: the path the old agent already holds still works.
  const handshakeAfter = await handshake(agentEntry, home);
  check("agent created before the update still works", handshakeAfter.tools === 9,
    `${handshakeAfter.tools} tools, server ${handshakeAfter.name}`);
  check("launch command is a real node binary", /(?:^|\/)node(?:\.exe)?$/.test(after.command),
    after.command);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nOK: entry survives a plugin update." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
