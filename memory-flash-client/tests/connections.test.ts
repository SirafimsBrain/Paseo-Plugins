import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Connections registry tests. `PASEO_HOME` is pointed at a temp
 * directory so the suite never touches the real plugin data.
 */

let tempHome: string;
const previousHome = process.env.PASEO_HOME;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mfc-home-"));
  process.env.PASEO_HOME = tempHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

async function loadModule() {
  // Imported after PASEO_HOME is set: the module reads it per call, but a
  // fresh import keeps the expectations honest either way.
  return import("../server/connections");
}

describe("connections store", () => {
  it("starts empty when no file exists", async () => {
    const { listConnections, listViews } = await loadModule();
    expect(listConnections()).toEqual([]);
    expect(listViews()).toEqual([]);
  });

  it("creates a connection, derives the key prefix and normalizes the url", async () => {
    const { saveConnection, listViews } = await loadModule();
    const result = saveConnection({
      id: "",
      label: "office",
      url: "100.64.0.2:8787",
      secret: "mf_live_abcdefghijklmnop",
      enabled: true,
    });
    expect(result.ok).toBe(true);
    expect(result.id).toMatch(/^conn_/);

    const [view] = listViews();
    expect(view.url).toBe("http://100.64.0.2:8787/mcp");
    expect(view.keyPrefix).toBe("mf_live_abcd");
    expect(view.status).toBe("unknown");
    expect(view.lastError).toBeNull();
  });

  it("keeps an existing url scheme and path when normalizing", async () => {
    const { saveConnection, listViews } = await loadModule();
    saveConnection({
      id: "",
      label: "lan",
      url: "https://memory.example.com/mcp",
      secret: "mf_live_one",
      enabled: true,
    });
    expect(listViews()[0].url).toBe("https://memory.example.com/mcp");
  });

  it("never exposes the secret in the view", async () => {
    const { saveConnection, listViews } = await loadModule();
    saveConnection({
      id: "",
      label: "secret-host",
      url: "http://127.0.0.1:8787/mcp",
      secret: "mf_live_supersecretvalue",
      enabled: true,
    });
    const view = listViews()[0] as Record<string, unknown>;
    expect("secret" in view).toBe(false);
    expect(JSON.stringify(listViews())).not.toContain("supersecret");
  });

  it("updates an existing connection and preserves its check state", async () => {
    const { saveConnection, listViews, persistCheck } = await loadModule();
    const created = saveConnection({
      id: "",
      label: "one",
      url: "http://127.0.0.1:8787/mcp",
      secret: "mf_live_first",
      enabled: true,
    });
    persistCheck(created.id, "ok", null);
    const updated = saveConnection({
      id: created.id,
      label: "one-renamed",
      url: "http://127.0.0.1:9999/mcp",
      secret: "mf_live_second",
      enabled: false,
    });
    expect(updated.id).toBe(created.id);

    const views = listViews();
    expect(views).toHaveLength(1);
    expect(views[0].label).toBe("one-renamed");
    expect(views[0].enabled).toBe(false);
    expect(views[0].status).toBe("ok");
    expect(views[0].checkedAt).not.toBeNull();
  });

  it("persists a failed check with its error", async () => {
    const { saveConnection, listViews, persistCheck } = await loadModule();
    const created = saveConnection({
      id: "",
      label: "broken",
      url: "http://127.0.0.1:1/mcp",
      secret: "mf_live_x",
      enabled: true,
    });
    persistCheck(created.id, "error", "Connection refused by http://127.0.0.1:1/mcp.");
    expect(listViews()[0].status).toBe("error");
    expect(listViews()[0].lastError).toContain("Connection refused");
  });

  it("deletes a connection and reports unknown ids", async () => {
    const { saveConnection, deleteConnection, listConnections } = await loadModule();
    const created = saveConnection({
      id: "",
      label: "temp",
      url: "http://127.0.0.1:8787/mcp",
      secret: "mf_live_temp",
      enabled: true,
    });
    expect(deleteConnection("does-not-exist")).toBe(false);
    expect(deleteConnection(created.id)).toBe(true);
    expect(listConnections()).toEqual([]);
  });

  it("writes the registry with owner-only permissions", async () => {
    const { saveConnection, connectionsFilePath } = await loadModule();
    saveConnection({
      id: "",
      label: "perms",
      url: "http://127.0.0.1:8787/mcp",
      secret: "mf_live_perms",
      enabled: true,
    });
    const mode = fs.statSync(connectionsFilePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("recovers from a corrupted registry file", async () => {
    const { saveConnection, connectionsFilePath, listViews } = await loadModule();
    fs.mkdirSync(path.dirname(connectionsFilePath()), { recursive: true });
    fs.writeFileSync(connectionsFilePath(), "{not json", "utf-8");
    expect(listViews()).toEqual([]);
    const result = saveConnection({
      id: "",
      label: "after-corruption",
      url: "http://127.0.0.1:8787/mcp",
      secret: "mf_live_ok",
      enabled: true,
    });
    expect(result.ok).toBe(true);
    expect(listViews()).toHaveLength(1);
  });
});

describe("normalizeUrl", () => {
  it("adds the http scheme and the /mcp path", async () => {
    const { normalizeUrl } = await loadModule();
    expect(normalizeUrl("100.64.0.2:8787")).toBe("http://100.64.0.2:8787/mcp");
    expect(normalizeUrl("http://host:1234/")).toBe("http://host:1234/mcp");
    expect(normalizeUrl("http://host:1234/mcp")).toBe("http://host:1234/mcp");
  });

  it("leaves a non-parseable value for the probe to report", async () => {
    const { normalizeUrl } = await loadModule();
    // A value that cannot be parsed into a URL is handed back trimmed, so
    // the probe can produce its own error message for it.
    expect(normalizeUrl("  not a url  ")).toBe("not a url");
  });
});
