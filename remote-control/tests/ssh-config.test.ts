// Stage 0.25.11 (H3): parse-and-preserve `~/.ssh/config`, atomic writes with a
// revision check, and the connection → Host block mapping.

import * as fs from "node:fs";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Connection } from "../shared/connections";
import {
  expandInclude,
  loadSshConfigTree,
  revisionOf,
  scanBlocks,
  sshAliasForConnection,
  sshConfigView,
  syncConnectionToSshConfig,
  upsertHostBlock,
  writeSshConfigFile,
} from "../server/ssh-config";

let dir: string;
let config: string;

const ROOT_CONFIG = `# my own comments stay
Include conf.d/*.conf

Host handwritten
  HostName handwritten.example.com
  User bob
  ForwardAgent yes

Host work-*
  User shared

Match host *.internal
  ProxyJump bastion.example.com
`;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "remote-control-ssh-config-"));
  config = path.join(dir, "config");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn_1",
    groupId: null,
    name: "Work box",
    protocol: "ssh",
    host: "work.example.com",
    port: 2222,
    username: "alice",
    payload: {},
    secretRefs: {},
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    ...overrides,
  } as Connection;
}

describe("parsing", () => {
  it("keeps hand-written blocks, wildcard rules and Match blocks apart", () => {
    writeFileSync(config, ROOT_CONFIG);
    fs.mkdirSync(path.join(dir, "conf.d"));
    writeFileSync(path.join(dir, "conf.d", "extra.conf"), "Host included\n  HostName included.example.com\n");

    const tree = loadSshConfigTree(config);
    expect(tree.exists).toBe(true);
    expect(tree.warnings).toEqual([]);
    expect(tree.includes).toEqual([{ pattern: "conf.d/*.conf", files: [path.join(dir, "conf.d", "extra.conf")] }]);

    const byAlias = Object.fromEntries(tree.hosts.map((host) => [host.alias, host]));
    expect(Object.keys(byAlias).sort()).toEqual(["handwritten", "included", "work-*"]);
    expect(byAlias.handwritten.connectable).toBe(true);
    expect(byAlias.handwritten.directives.hostname).toEqual(["handwritten.example.com"]);
    expect(byAlias["work-*"].wildcard).toBe(true);
    expect(byAlias["work-*"].connectable).toBe(false);
    // `Match` is a rule, not a host: its directives belong to no block.
    expect(tree.hosts.some((host) => host.patterns.includes("*") && host.alias === "*")).toBe(false);

    const view = sshConfigView(tree);
    expect(view.files).toHaveLength(2);
    expect(view.files.find((file) => file.path.endsWith("extra.conf"))?.included).toBe(true);
    expect(view.revision).toBe(revisionOf(ROOT_CONFIG));
  });

  it("marks the block owned by a connection", () => {
    const text = `# remote-control: conn_9\nHost managed\n  HostName managed.example.com\n\nHost other\n  HostName other.example.com\n`;
    writeFileSync(config, text);
    const tree = loadSshConfigTree(config);
    expect(tree.hosts.find((host) => host.alias === "managed")?.managedConnectionId).toBe("conn_9");
    expect(tree.hosts.find((host) => host.alias === "other")?.managedConnectionId).toBeNull();
  });

  it("expands Include globs relative to the ssh directory", () => {
    fs.mkdirSync(path.join(dir, "conf.d"));
    writeFileSync(path.join(dir, "conf.d", "a.conf"), "");
    writeFileSync(path.join(dir, "conf.d", "b.conf"), "");
    expect(expandInclude("conf.d/*.conf", dir)).toEqual([
      path.join(dir, "conf.d", "a.conf"),
      path.join(dir, "conf.d", "b.conf"),
    ]);
    expect(expandInclude("missing/*.conf", dir)).toEqual([]);
  });

  it("scans blocks without expanding includes", () => {
    const blocks = scanBlocks(ROOT_CONFIG);
    expect(blocks.map((block) => block.patterns.join(" "))).toEqual(["handwritten", "work-*"]);
  });
});

describe("upsert", () => {
  it("appends a marked block and leaves every existing byte alone", () => {
    writeFileSync(config, ROOT_CONFIG);
    const result = upsertHostBlock(ROOT_CONFIG, {
      alias: "work",
      hostName: "work.example.com",
      user: "alice",
      port: 2222,
    }, { connectionId: "conn_1" });

    expect(result.action).toBe("created");
    expect(result.text.startsWith(ROOT_CONFIG.trimEnd())).toBe(true);
    expect(result.text).toContain("# remote-control: conn_1\nHost work\n  HostName work.example.com\n  User alice\n  Port 2222\n");
    expect(result.text.endsWith("\n")).toBe(true);
    // A one-element change must not disturb the hand-written part.
    expect(result.text).toContain("ForwardAgent yes");
  });

  it("rewrites only the directives it owns, keeping unknown lines in the block", () => {
    const text = [
      "# remote-control: conn_1",
      "Host work",
      "  HostName old.example.com",
      "  User olduser",
      "  Port 2200",
      "  ForwardAgent yes",
      "",
      "Host keep",
      "  HostName keep.example.com",
      "",
    ].join("\n");
    const result = upsertHostBlock(text, {
      alias: "work",
      hostName: "new.example.com",
      port: 22,
      identityFile: "~/.ssh/id_ed25519",
    }, { connectionId: "conn_1" });

    expect(result.action).toBe("updated");
    expect(result.text).toContain("Host work\n  HostName new.example.com\n  IdentityFile ~/.ssh/id_ed25519");
    expect(result.text).toContain("ForwardAgent yes");
    expect(result.text).not.toContain("old.example.com");
    expect(result.text).not.toContain("olduser");
    // Port 22 is the default and must not be written out.
    expect(result.text).not.toContain("Port 22");
    expect(result.text).toContain("Host keep\n  HostName keep.example.com");
  });

  it("refuses an alias the user typed by hand", () => {
    expect(() =>
      upsertHostBlock(ROOT_CONFIG, { alias: "handwritten", hostName: "x" }, { connectionId: "conn_1" }),
    ).toThrow(/already exists at line 4 and was not created by remote-control/);
  });
});

describe("writing", () => {
  it("keeps the mode, writes a backup and bumps the revision", () => {
    writeFileSync(config, ROOT_CONFIG, { mode: 0o600 });
    fs.chmodSync(config, 0o600);
    const result = writeSshConfigFile(config, `${ROOT_CONFIG}\nHost added\n  HostName added.example.com\n`, revisionOf(ROOT_CONFIG));

    expect(fs.statSync(config).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(`${config}.remote-control.bak`, "utf8")).toBe(ROOT_CONFIG);
    expect(result.revision).toBe(revisionOf(fs.readFileSync(config, "utf8")));
    expect(fs.readFileSync(config, "utf8")).toContain("Host added");
  });

  it("refuses a stale revision instead of overwriting a hand edit", () => {
    writeFileSync(config, ROOT_CONFIG);
    const before = fs.readFileSync(config, "utf8");
    fs.appendFileSync(config, "\n# typed while the plugin was open\n");
    expect(() => writeSshConfigFile(config, "Host replaced\n", revisionOf(before))).toThrow(/changed on disk/);
    expect(fs.readFileSync(config, "utf8")).toContain("# typed while the plugin was open");
  });

  it("refuses a symlink", () => {
    const target = path.join(dir, "dotfiles-config");
    writeFileSync(target, "Host linked\n");
    symlinkSync(target, config);
    expect(() => writeSshConfigFile(config, "Host x\n")).toThrow(/symlink/);
    expect(fs.readFileSync(target, "utf8")).toBe("Host linked\n");
  });
});

describe("connection mapping", () => {
  it("slugs the name and rejects a wildcard alias", () => {
    expect(sshAliasForConnection(connection())).toBe("work-box");
    expect(sshAliasForConnection(connection({ payload: { sshAlias: "work" } }))).toBe("work");
    expect(() => sshAliasForConnection(connection({ payload: { sshAlias: "*" } }))).toThrow(/invalid ssh alias/);
    expect(sshAliasForConnection(connection({ name: "Рабочий сервер", host: "10.1.2.3" }))).toBe("rc-10.1.2.3");
  });

  it("creates once, then updates the same block in place", () => {
    writeFileSync(config, ROOT_CONFIG);
    const first = syncConnectionToSshConfig(connection(), { configPath: config });
    expect(first.action).toBe("created");
    expect(first.path).toBe(config);

    const second = syncConnectionToSshConfig(
      connection({ host: "work2.example.com", username: "", payload: { proxyJump: "bastion" } }),
      { configPath: config },
    );
    expect(second.action).toBe("updated");
    const text = fs.readFileSync(config, "utf8");
    expect(text.match(/^# remote-control: conn_1$/gm)).toHaveLength(1);
    expect(text).toContain("HostName work2.example.com");
    expect(text).toContain("ProxyJump bastion");
    expect(text).not.toContain("User alice");
    expect(text).toContain("Host handwritten\n  HostName handwritten.example.com\n  User bob\n  ForwardAgent yes");
  });

  it("updates a managed block in the include that owns it", () => {
    fs.mkdirSync(path.join(dir, "conf.d"));
    const included = path.join(dir, "conf.d", "extra.conf");
    writeFileSync(included, "# remote-control: conn_1\nHost work\n  HostName old.example.com\n");
    writeFileSync(config, "Include conf.d/*.conf\n");

    const result = syncConnectionToSshConfig(connection(), { configPath: config });
    expect(result.path).toBe(included);
    expect(result.action).toBe("updated");
    expect(fs.readFileSync(included, "utf8")).toContain("HostName work.example.com");
    // The root file is untouched.
    expect(fs.readFileSync(config, "utf8")).toBe("Include conf.d/*.conf\n");
  });

  it("reports a hand-written alias instead of taking it over", () => {
    writeFileSync(config, "Host work\n  HostName hand.example.com\n");
    expect(() =>
      syncConnectionToSshConfig(connection({ payload: { sshAlias: "work" } }), { configPath: config }),
    ).toThrow(/set another alias/);
    expect(fs.readFileSync(config, "utf8")).toBe("Host work\n  HostName hand.example.com\n");
  });
});
