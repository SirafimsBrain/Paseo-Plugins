import { describe, expect, it, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkRemoteHost,
  deleteRemoteHost,
  listRemoteHosts,
  saveRemoteHost,
} from "../server/remote-hosts";
import {
  installSkill,
  skillMarkdown,
  skillStatuses,
  uninstallSkill,
} from "../server/skill";

// Isolate $PASEO_HOME (hosts.json lives there) and $HOME: skill targets
// resolve through os.homedir(), which on POSIX reads $HOME — without this
// the install/uninstall test would touch the real ~/.agents/skills.
let home: string;
let originalPaseoHome: string | undefined;
let originalHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mf-hosts-"));
  originalPaseoHome = process.env.PASEO_HOME;
  originalHome = process.env.HOME;
  process.env.PASEO_HOME = home;
  process.env.HOME = home;
  return () => {
    if (originalPaseoHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = originalPaseoHome;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  };
});

describe("remote hosts registry", () => {
  it("starts empty and saves hosts", () => {
    expect(listRemoteHosts()).toEqual([]);
    const result = saveRemoteHost({
      id: "",
      name: "GPU box",
      transport: "paseo-ssh",
      host: "192.168.1.50",
      port: 22,
      user: "dev",
      enabled: true,
    });
    expect(result.ok).toBe(true);
    const hosts = listRemoteHosts();
    expect(hosts).toHaveLength(1);
    expect(hosts[0].name).toBe("GPU box");
    expect(hosts[0].status).toBe("unknown");
  });

  it("updates an existing host by id", () => {
    const created = saveRemoteHost({ id: "", name: "A", transport: "paseo-ssh", host: "h1", port: 22, user: "", enabled: true });
    saveRemoteHost({ id: created.id, name: "A2", transport: "paseo-ssh", host: "h2", port: 2222, user: "u", enabled: true });
    const hosts = listRemoteHosts();
    expect(hosts).toHaveLength(1);
    expect(hosts[0].name).toBe("A2");
    expect(hosts[0].port).toBe(2222);
  });

  it("deletes hosts", () => {
    const created = saveRemoteHost({ id: "", name: "B", transport: "paseo-ssh", host: "h", port: 22, user: "", enabled: true });
    expect(deleteRemoteHost(created.id)).toBe(true);
    expect(deleteRemoteHost("missing")).toBe(false);
    expect(listRemoteHosts()).toHaveLength(0);
  });

  it("checkRemoteHost reports stub transports as unsupported", () => {
    const created = saveRemoteHost({ id: "", name: "R", transport: "relay", host: "h", port: 22, user: "", enabled: true });
    const result = checkRemoteHost(created.id);
    expect(result.status).toBe("unsupported");
    const hosts = listRemoteHosts();
    expect(hosts[0].status).toBe("unsupported");
  });
});

describe("skill installer", () => {
  it("reports targets with install state", () => {
    const statuses = skillStatuses();
    expect(statuses.length).toBe(7);
    // All targets should have the skill file path containing "memory-flash/SKILL.md"
    for (const status of statuses) {
      expect(status.path).toContain("memory-flash/SKILL.md");
      expect(typeof status.detected).toBe("boolean");
      expect(typeof status.installed).toBe("boolean");
      // upToDate is boolean when installed, null when not
      if (status.installed) {
        expect(typeof status.upToDate).toBe("boolean");
      } else {
        expect(status.upToDate).toBeNull();
      }
    }
    // Check all expected targets are present
    const ids = statuses.map((s) => s.id).sort();
    expect(ids).toEqual([
      "agents",
      "claude",
      "cline",
      "codex",
      "kilo",
      "opencode",
      "qwen",
    ]);
  });

  it("installs and uninstalls into a target directory", () => {
    const agents = skillStatuses().find((status) => status.id === "agents") as { path: string };
    const install = installSkill("agents");
    expect(install.ok).toBe(true);
    expect(fs.existsSync(agents.path)).toBe(true);
    const content = fs.readFileSync(agents.path, "utf-8");
    expect(content).toContain("name: memory-flash");
    expect(content).toContain("memory_search");
    expect(content).toContain("memory_handoff");

    const afterInstall = skillStatuses().find((status) => status.id === "agents");
    expect(afterInstall?.installed).toBe(true);
    expect(afterInstall?.upToDate).toBe(true);

    const uninstall = uninstallSkill("agents");
    expect(uninstall.ok).toBe(true);
    expect(fs.existsSync(agents.path)).toBe(false);
  });

  it("rejects unknown targets", () => {
    expect(installSkill("nope").ok).toBe(false);
    expect(uninstallSkill("nope").ok).toBe(false);
  });

  it("ships a meaningful skill document", () => {
    const markdown = skillMarkdown();
    expect(markdown).toMatch(/^---\n/);
    expect(markdown).toContain("memory_save");
    expect(markdown).toContain("memory_search");
    expect(markdown).toContain("memory_update");
    expect(markdown).toContain("memory_delete");
    expect(markdown).toContain("handoff");
  });
});
