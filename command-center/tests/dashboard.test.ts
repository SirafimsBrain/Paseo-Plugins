import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CommandDefinition, HistoryEntry } from "../shared/commands";
import { escapeHtml, renderDashboardHtml } from "../shared/dashboard";
import { appendHistory, saveCommands } from "../server/store";
import { ensureDashboard, stopDashboard } from "../server/dashboard";

const home = mkdtempSync(path.join(tmpdir(), "cc-dashboard-"));

function command(overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    id: "cmd_1",
    name: "Deploy staging",
    type: "prompt",
    template: "Deploy {{input:service}}",
    variables: [{ name: "service", prompt: "Service", kind: "text" }],
    steps: [],
    scope: "global",
    provider: "cline/claude-opus-4-6",
    category: "ops",
    favorite: true,
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
    useCount: 4,
    ...overrides,
  };
}

const entry: HistoryEntry = {
  id: "h_1",
  commandId: "cmd_1",
  commandName: "Deploy staging",
  rendered: "Deploy api",
  targetWorkspaceId: "w1",
  targetAgentId: null,
  kind: "new-agent",
  ok: false,
  error: "daemon refused",
  at: "2026-11-11T10:00:00.000Z",
};

beforeAll(() => {
  process.env.PASEO_HOME = home;
  saveCommands([command()]);
  appendHistory([], entry);
});

afterAll(() => {
  stopDashboard();
  delete process.env.PASEO_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("renderDashboardHtml", () => {
  it("lists commands and runs and escapes markup", () => {
    const html = renderDashboardHtml({
      commands: [command({ name: '<script>alert("x")</script>' })],
      history: [
        { ...entry, error: null, rendered: "<img src=x onerror=alert(1)>" },
        entry,
      ],
      now: new Date("2026-11-11T12:00:00.000Z"),
    });
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("Deploy staging");
    expect(html).toContain("daemon refused");
    expect(html).toContain("Read-only");
  });

  it("renders empty states", () => {
    const html = renderDashboardHtml({ commands: [], history: [], now: new Date() });
    expect(html).toContain("No commands saved yet.");
    expect(html).toContain("Nothing has run yet.");
  });

  it("escapes the five HTML metacharacters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("loopback dashboard server", () => {
  it("starts on 127.0.0.1 and serves the page only with the token", async () => {
    const started = await ensureDashboard();
    expect(started.error).toBeNull();
    expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+$/);

    const url = new URL(started.url!);
    const authorized = await fetch(url);
    expect(authorized.status).toBe(200);
    expect(authorized.headers.get("content-type")).toContain("text/html");
    expect(authorized.headers.get("cache-control")).toContain("no-store");
    expect(authorized.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await authorized.text();
    expect(html).toContain("Deploy staging");
    expect(html).toContain("daemon refused");

    const unauthorized = await fetch(`${url.origin}/`);
    expect(unauthorized.status).toBe(401);

    const wrongToken = await fetch(`${url.origin}/?token=deadbeef`);
    expect(wrongToken.status).toBe(401);

    const notFound = await fetch(`${url.origin}/other?token=${url.searchParams.get("token")}`);
    expect(notFound.status).toBe(404);

    const mutation = await fetch(url, { method: "POST" });
    expect(mutation.status).toBe(405);
  });

  it("reuses the same URL on later calls", async () => {
    const first = await ensureDashboard();
    const second = await ensureDashboard();
    expect(second.url).toBe(first.url);
  });
});
