// `~/.ssh/config` management (stage 0.25.11, H3).
//
// The user's config is the source of truth (sshpilot model): this module
// parses the root file and every file it `Include`s, never regenerates the
// file, and edits only the block it owns. A managed block is marked by a
// comment line directly above its `Host` line:
//
//     # remote-control: conn_abc123
//     Host work
//       HostName work.example.com
//       User alice
//
// Everything else — hand-written blocks, wildcard/Match rules, unknown
// directives — is left byte-for-byte intact. Writes are atomic (same-directory
// temp file + rename), revision-checked (a concurrent hand edit is reported,
// not overwritten), symlink-refusing and keep the file mode; the previous
// content is kept as `<config>.remote-control.bak`.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Connection } from "../shared/connections";

/** Directives the plugin owns inside a managed block. */
export const MANAGED_SSH_KEYS = ["hostname", "user", "port", "identityfile", "proxyjump"] as const;
const MARKER_PREFIX = "# remote-control:";
const MAX_INCLUDE_DEPTH = 8;

export interface SshStatement {
  /** 0-based line index in the source text. */
  index: number;
  key: string;
  value: string;
}

export interface ParsedSshBlock {
  /** 0-based index of the `Host` line. */
  headerIndex: number;
  /** Exclusive end index: the block ends before the next Host/Match line. */
  endIndex: number;
  patterns: string[];
  markerConnectionId: string | null;
}

export interface SshConfigHost {
  alias: string;
  patterns: string[];
  /** Lower-cased directive name → every value in the block, in order. */
  directives: Record<string, string[]>;
  file: string;
  /** 1-based, like an editor shows them. */
  startLine: number;
  endLine: number;
  managedConnectionId: string | null;
  /** A wildcard or negated block is a rule, not a connectable host. */
  connectable: boolean;
  wildcard: boolean;
}

export interface SshConfigFileView {
  path: string;
  revision: string;
  exists: boolean;
  included: boolean;
}

export interface SshConfigView {
  path: string;
  revision: string;
  exists: boolean;
  hosts: SshConfigHost[];
  includes: { pattern: string; files: string[] }[];
  files: SshConfigFileView[];
  warnings: string[];
}

/** Root path: `REMOTE_CONTROL_SSH_CONFIG` (tests/live checks) or `~/.ssh/config`. */
export function defaultSshConfigPath(): string {
  const override = process.env.REMOTE_CONTROL_SSH_CONFIG?.trim();
  if (override) return expandHome(override);
  return path.join(os.homedir(), ".ssh", "config");
}

export function revisionOf(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/** `Host`/`HostName`/`HostName=value`, comments and blanks skipped. */
export function parseStatement(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return null;
  const equals = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*)$/.exec(trimmed);
  if (equals) return { key: equals[1].toLowerCase(), value: equals[2].trim() };
  const spaced = /^([A-Za-z][A-Za-z0-9]*)(?:\s+(.*))?$/.exec(trimmed);
  if (spaced) return { key: spaced[1].toLowerCase(), value: (spaced[2] ?? "").trim() };
  return null;
}

export function parseStatements(text: string): SshStatement[] {
  const out: SshStatement[] = [];
  text.split("\n").forEach((line, index) => {
    const parsed = parseStatement(line);
    if (parsed) out.push({ index, ...parsed });
  });
  return out;
}

/** Marker comment of the line directly above `headerIndex`, if any. */
function markerBefore(lines: readonly string[], headerIndex: number): string | null {
  const previous = headerIndex > 0 ? lines[headerIndex - 1].trim() : "";
  if (!previous.startsWith(MARKER_PREFIX)) return null;
  const id = previous.slice(MARKER_PREFIX.length).trim();
  return id.length > 0 ? id : null;
}

/**
 * Splits one file's text into `Host` blocks. `Match` blocks (and everything
 * after them) belong to no Host and are preserved untouched: they are rules,
 * not connectable entries.
 */
export function scanBlocks(text: string): ParsedSshBlock[] {
  const lines = text.split("\n");
  const blocks: ParsedSshBlock[] = [];
  let current: ParsedSshBlock | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseStatement(lines[index]);
    if (!parsed) continue;
    if (parsed.key !== "host" && parsed.key !== "match") continue;
    if (current) {
      current.endIndex = index;
      blocks.push(current);
      current = null;
    }
    if (parsed.key === "host") {
      current = {
        headerIndex: index,
        endIndex: lines.length,
        patterns: parsed.value.split(/\s+/).filter((token) => token.length > 0),
        markerConnectionId: markerBefore(lines, index),
      };
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/** True when every token is a literal host name (no wildcard, no negation). */
export function isLiteralPattern(pattern: string): boolean {
  return !pattern.startsWith("!") && !/[*?]/.test(pattern);
}

function directivesOf(lines: readonly string[], block: ParsedSshBlock): Record<string, string[]> {
  const directives: Record<string, string[]> = {};
  for (let index = block.headerIndex + 1; index < block.endIndex; index += 1) {
    const parsed = parseStatement(lines[index]);
    if (!parsed) continue;
    (directives[parsed.key] ??= []).push(parsed.value);
  }
  return directives;
}

function hostOf(text: string, block: ParsedSshBlock, file: string): SshConfigHost {
  const lines = text.split("\n");
  const literal = block.patterns.filter(isLiteralPattern);
  return {
    alias: literal[0] ?? block.patterns[0] ?? "",
    patterns: block.patterns,
    directives: directivesOf(lines, block),
    file,
    startLine: block.headerIndex + 1,
    endLine: block.endIndex,
    managedConnectionId: block.markerConnectionId,
    connectable: literal.length > 0,
    wildcard: literal.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Include expansion
// ---------------------------------------------------------------------------

function segmentMatcher(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

/**
 * `Include` paths are absolute, `~`-relative or relative to the ssh directory
 * (ssh_config(5)); each pattern may contain `*`/`?` globs. Returns files only,
 * sorted, missing paths dropped.
 */
export function expandInclude(pattern: string, sshDir: string): string[] {
  const raw = expandHome(pattern.trim());
  const absolute = path.isAbsolute(raw) ? raw : path.join(sshDir, raw);
  const normalized = path.normalize(absolute);
  const root = path.parse(normalized).root;
  const segments = normalized.slice(root.length).split(path.sep).filter(Boolean);
  let candidates: string[] = [root];
  for (const segment of segments) {
    if (!/[*?]/.test(segment)) {
      candidates = candidates.map((base) => path.join(base, segment));
      continue;
    }
    const matcher = segmentMatcher(segment);
    const next: string[] = [];
    for (const base of candidates) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(base, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!matcher.test(entry.name)) continue;
        next.push(path.join(base, entry.name));
      }
    }
    candidates = next;
  }
  return candidates
    .filter((candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface SshConfigTree {
  path: string;
  exists: boolean;
  revision: string;
  /** Every parsed file (root first, then includes in parse order). */
  texts: Map<string, string>;
  hosts: SshConfigHost[];
  includes: { pattern: string; files: string[] }[];
  warnings: string[];
  includedPaths: Set<string>;
}

export function loadSshConfigTree(configPath = defaultSshConfigPath()): SshConfigTree {
  const pathToConfig = path.resolve(expandHome(configPath));
  const sshDir = path.dirname(pathToConfig);
  const texts = new Map<string, string>();
  const hosts: SshConfigHost[] = [];
  const includes: { pattern: string; files: string[] }[] = [];
  const warnings: string[] = [];
  const includedPaths = new Set<string>();
  const visited = new Set<string>();

  const readFile = (file: string): string | null => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        warnings.push(`cannot read ${file}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      return null;
    }
  };

  const walk = (file: string, depth: number, included: boolean): void => {
    const resolved = path.resolve(file);
    if (visited.has(resolved)) {
      if (included) warnings.push(`include cycle at ${resolved}`);
      return;
    }
    visited.add(resolved);
    const text = readFile(resolved);
    if (text === null) return;
    texts.set(resolved, text);
    if (included) includedPaths.add(resolved);

    for (const block of scanBlocks(text)) {
      hosts.push(hostOf(text, block, resolved));
    }

    for (const statement of parseStatements(text)) {
      if (statement.key !== "include") continue;
      if (depth >= MAX_INCLUDE_DEPTH) {
        warnings.push(`include depth limit reached at ${resolved}:${statement.index + 1}`);
        continue;
      }
      for (const pattern of statement.value.split(/\s+/).filter(Boolean)) {
        const files = expandInclude(pattern, path.dirname(pathToConfig));
        includes.push({ pattern, files });
        for (const child of files) walk(child, depth + 1, true);
      }
    }
  };

  walk(pathToConfig, 0, false);

  return {
    path: pathToConfig,
    exists: texts.has(pathToConfig),
    revision: revisionOf(texts.get(pathToConfig) ?? ""),
    texts,
    hosts,
    includes,
    warnings,
    includedPaths,
  };
}

/** The public side of a tree — no file contents leave the plugin. */
export function sshConfigView(tree: SshConfigTree): SshConfigView {
  return {
    path: tree.path,
    revision: tree.revision,
    exists: tree.exists,
    hosts: tree.hosts,
    includes: tree.includes,
    files: [...tree.texts.entries()].map(([file, text]) => ({
      path: file,
      revision: revisionOf(text),
      exists: true,
      included: tree.includedPaths.has(file),
    })),
    warnings: tree.warnings,
  };
}

// ---------------------------------------------------------------------------
// Mapping a connection to a Host block
// ---------------------------------------------------------------------------

export interface SshHostSpec {
  alias: string;
  hostName: string;
  user?: string;
  port?: number | null;
  identityFile?: string;
  proxyJump?: string;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/-+$/, "");
}

/**
 * Alias for a connection: `payload.sshAlias` when set, otherwise a slug of the
 * connection name, otherwise `rc-<host>`. The result must be a literal Host
 * token — an alias containing `*`, `?` or a leading `!` would silently become
 * a rule for every host.
 */
export function sshAliasForConnection(connection: Connection): string {
  const payload = connection.payload ?? {};
  const configured = typeof payload.sshAlias === "string" ? payload.sshAlias.trim() : "";
  const candidate = configured.length > 0 ? configured : slug(connection.name) || `rc-${slug(connection.host)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate)) {
    throw new Error(
      `invalid ssh alias "${candidate}": use letters, digits, dot, underscore or dash, starting with a letter or digit`,
    );
  }
  return candidate;
}

export function sshHostSpecForConnection(connection: Connection): SshHostSpec {
  const payload = connection.payload ?? {};
  const identity = typeof payload.identityFile === "string" ? payload.identityFile.trim() : "";
  const proxyJump = typeof payload.proxyJump === "string" ? payload.proxyJump.trim() : "";
  return {
    alias: sshAliasForConnection(connection),
    hostName: connection.host,
    ...(connection.username.trim().length > 0 ? { user: connection.username.trim() } : {}),
    port: connection.port,
    ...(identity.length > 0 ? { identityFile: identity } : {}),
    ...(proxyJump.length > 0 ? { proxyJump } : {}),
  };
}

function managedLines(spec: SshHostSpec, indent: string): string[] {
  const lines: string[] = [`${indent}HostName ${spec.hostName}`];
  if (spec.user) lines.push(`${indent}User ${spec.user}`);
  if (spec.port !== null && spec.port !== undefined && spec.port !== 22) {
    lines.push(`${indent}Port ${spec.port}`);
  }
  if (spec.identityFile) lines.push(`${indent}IdentityFile ${spec.identityFile}`);
  if (spec.proxyJump) lines.push(`${indent}ProxyJump ${spec.proxyJump}`);
  return lines;
}

function indentOf(lines: readonly string[], block: ParsedSshBlock): string {
  for (let index = block.headerIndex + 1; index < block.endIndex; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) continue;
    const match = /^([ \t]+)/.exec(line);
    if (match) return match[1];
  }
  return "  ";
}

export interface UpsertResult {
  text: string;
  action: "created" | "updated";
}

/**
 * Inserts or rewrites the block owned by `connectionId`. A hand-written block
 * that already uses the alias is refused: rewriting it would take over an
 * entry the user typed, which the stage's preservation rule forbids.
 */
export function upsertHostBlock(
  text: string,
  spec: SshHostSpec,
  options: { connectionId?: string } = {},
): UpsertResult {
  const lines = text.split("\n");
  const blocks = scanBlocks(text);
  const connectionId = options.connectionId ?? null;

  if (connectionId) {
    const owned = blocks.find((block) => block.markerConnectionId === connectionId);
    if (owned) {
      const keep: string[] = [];
      for (let index = owned.headerIndex + 1; index < owned.endIndex; index += 1) {
        const parsed = parseStatement(lines[index]);
        if (parsed && (MANAGED_SSH_KEYS as readonly string[]).includes(parsed.key)) continue;
        keep.push(lines[index]);
      }
      while (keep.length > 0 && keep[keep.length - 1].trim() === "") keep.pop();
      const replacement = [
        `${MARKER_PREFIX} ${connectionId}`,
        `Host ${owned.patterns.join(" ")}`,
        ...managedLines(spec, indentOf(lines, owned)),
        ...keep,
      ];
      const next = [...lines];
      // The marker sits on the line above the header and is part of the block.
      next.splice(owned.headerIndex - 1, owned.endIndex - (owned.headerIndex - 1), ...replacement);
      return { text: next.join("\n"), action: "updated" };
    }
  }

  const collision = blocks.find((block) => block.patterns.some((pattern) => pattern === spec.alias));
  if (collision) {
    throw new Error(
      `the ssh alias "${spec.alias}" already exists at line ${collision.headerIndex + 1} and was not created by remote-control; set another alias on the connection (payload.sshAlias)`,
    );
  }

  const body = text.replace(/\n+$/, "");
  const prefix = body.length > 0 ? [body, ""] : [];
  const block = [
    `${MARKER_PREFIX} ${connectionId ?? "unmanaged"}`,
    `Host ${spec.alias}`,
    ...managedLines(spec, "  "),
  ];
  return { text: `${[...prefix, ...block].join("\n")}\n`, action: "created" };
}

export interface SshConfigWriteResult {
  revision: string;
  backup: string | null;
}

/**
 * Atomic replace: temp file in the same directory, fsync, rename, mode kept,
 * symlink refused, revision checked. The previous content lands in
 * `<file>.remote-control.bak` (single level, like a text editor's undo).
 */
export function writeSshConfigFile(
  file: string,
  text: string,
  expectedRevision?: string,
): SshConfigWriteResult {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  let mode = 0o600;
  let exists = false;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to write ${file}: it is a symlink (edit the link target by hand)`);
    }
    if (!stat.isFile()) {
      throw new Error(`refusing to write ${file}: not a regular file`);
    }
    exists = true;
    mode = stat.mode & 0o777;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }

  if (exists) {
    const current = fs.readFileSync(file, "utf8");
    if (expectedRevision !== undefined && revisionOf(current) !== expectedRevision) {
      throw new Error(
        `the ssh config changed on disk since it was read (${file}); reload it and retry so the hand edit is not lost`,
      );
    }
  }

  let backup: string | null = null;
  if (exists) {
    backup = `${file}.remote-control.bak`;
    fs.copyFileSync(file, backup);
    try {
      fs.chmodSync(backup, mode);
    } catch {
      // ignore
    }
  }

  const temp = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  const fd = fs.openSync(temp, "w", mode);
  try {
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temp, file);
    fs.chmodSync(file, mode);
  } catch (cause) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // ignore
    }
    throw cause;
  }
  return { revision: revisionOf(text), backup };
}

export interface SshConfigSyncResult {
  path: string;
  alias: string;
  host: string;
  action: "created" | "updated";
  revision: string;
  backup: string | null;
}

/**
 * Read-modify-write of the user's config for one connection. The block is
 * updated where it already lives (an included file stays the file that owns
 * it); a new block is appended to the root config.
 */
export function syncConnectionToSshConfig(
  connection: Connection,
  options: { configPath?: string } = {},
): SshConfigSyncResult {
  if (connection.protocol !== "ssh") {
    throw new Error(`ssh config sync supports ssh connections only (this one is ${connection.protocol})`);
  }
  const tree = loadSshConfigTree(options.configPath ?? defaultSshConfigPath());
  const spec = sshHostSpecForConnection(connection);
  const owned = tree.hosts.find((host) => host.managedConnectionId === connection.id);
  const target = owned ? owned.file : tree.path;

  if (!owned) {
    const collision = tree.hosts.find((host) => host.patterns.includes(spec.alias));
    if (collision) {
      throw new Error(
        `the ssh alias "${spec.alias}" already exists in ${collision.file} at line ${collision.startLine} and was not created by remote-control; set another alias on the connection (payload.sshAlias)`,
      );
    }
  }

  const source = tree.texts.get(target) ?? "";
  const upserted = upsertHostBlock(source, spec, { connectionId: connection.id });
  const written = writeSshConfigFile(
    target,
    upserted.text,
    tree.texts.has(target) ? revisionOf(source) : undefined,
  );
  return {
    path: target,
    alias: spec.alias,
    host: spec.hostName,
    action: upserted.action,
    revision: written.revision,
    backup: written.backup,
  };
}
