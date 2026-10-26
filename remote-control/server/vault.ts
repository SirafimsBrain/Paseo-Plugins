// Pass-backed secret vault (stage C1, ADR-4).
//
// Isolated GNUPGHOME + PASSWORD_STORE_DIR so the plugin never touches the
// user's own GPG home or pass store. The master password is the passphrase
// of the plugin's own GPG key; it is cached in memory (as a Buffer) after a
// successful unlock and zeroed on lock(). Encryption (writing a secret) uses
// the recipient's public key and needs no passphrase; decryption uses the
// cached passphrase via --passphrase-fd 0.

import * as child from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface VaultOptions {
  paseoHome?: string;
  storeDir?: string;
  gnupgHome?: string;
  now?: () => number;
  /** Auto-lock after this many ms of inactivity; 0 disables. */
  autoLockMs?: number;
  log?: (message: string) => void;
}

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
  entries: string[];
  storeDir: string;
  gnupgHome: string;
  keyId: string | null;
  autoLockMs: number;
}

export class VaultLockedError extends Error {
  constructor() {
    super("vault is locked");
    this.name = "VaultLockedError";
  }
}

export class VaultNotInitializedError extends Error {
  constructor() {
    super("vault is not initialized");
    this.name = "VaultNotInitializedError";
  }
}

const PROBE_NAME = ".probe";
const KEY_UID = "remote-control <remote-control@local>";

function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string | Buffer,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const childProc = child.execFile(
      cmd,
      args,
      { env, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
    if (input !== undefined && childProc.stdin) {
      childProc.stdin.write(input);
      childProc.stdin.end();
    }
  });
}

export class VaultService {
  readonly storeDir: string;
  readonly gnupgHome: string;
  private keyId: string | null = null;
  private passphrase: Buffer | null = null;
  private autoLockMs: number;
  private autoLockTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private readonly log: (m: string) => void;

  constructor(options: VaultOptions = {}) {
    const home = options.paseoHome ?? process.env.PASEO_HOME ?? path.join(process.env.HOME ?? "", ".paseo");
    this.storeDir = options.storeDir ?? path.join(home, "pass-store");
    this.gnupgHome = options.gnupgHome ?? path.join(home, "pass-gnupg");
    this.autoLockMs = options.autoLockMs ?? 0;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
    fs.mkdirSync(this.gnupgHome, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.gnupgHome, 0o700);
    } catch {
      // ignore
    }
    // Disable passphrase caching so unlock() actually verifies the password.
    try {
      fs.writeFileSync(
        path.join(this.gnupgHome, "gpg-agent.conf"),
        "default-cache-ttl 0\nmax-cache-ttl 0\n",
        { mode: 0o600 },
      );
    } catch {
      // ignore
    }
    fs.mkdirSync(this.storeDir, { recursive: true, mode: 0o700 });
    this.loadKeyId();
  }

  private env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GNUPGHOME: this.gnupgHome,
      PASSWORD_STORE_DIR: this.storeDir,
    };
  }

  private gpgIdPath(): string {
    return path.join(this.storeDir, ".gpg-id");
  }

  private loadKeyId(): void {
    try {
      const raw = fs.readFileSync(this.gpgIdPath(), "utf8").trim();
      if (raw.length > 0) this.keyId = raw.split(/\s+/)[0];
    } catch {
      this.keyId = null;
    }
  }

  isInitialized(): boolean {
    return this.keyId !== null && fs.existsSync(this.gpgIdPath());
  }

  isUnlocked(): boolean {
    return this.passphrase !== null;
  }

  status(): VaultStatus {
    return {
      initialized: this.isInitialized(),
      unlocked: this.isUnlocked(),
      entries: this.isInitialized() ? this.listEntries() : [],
      storeDir: this.storeDir,
      gnupgHome: this.gnupgHome,
      keyId: this.keyId,
      autoLockMs: this.autoLockMs,
    };
  }

  setAutoLockMs(ms: number): void {
    this.autoLockMs = Math.max(0, ms);
    this.resetAutoLock();
  }

  private resetAutoLock(): void {
    if (this.autoLockTimer) {
      clearTimeout(this.autoLockTimer);
      this.autoLockTimer = null;
    }
    if (this.autoLockMs > 0 && this.isUnlocked()) {
      this.autoLockTimer = setTimeout(() => {
        this.log("[remote-control] vault auto-lock");
        this.lock();
      }, this.autoLockMs);
    }
  }

  private touch(): void {
    this.resetAutoLock();
  }

  async setup(masterPassword: string, keyIdOverride?: string): Promise<{ generated: boolean }> {
    if (masterPassword.length === 0) {
      throw new Error("master password must not be empty");
    }
    if (this.isInitialized() && !keyIdOverride) {
      return { generated: false };
    }
    let generated = false;
    if (keyIdOverride && keyIdOverride.trim().length > 0) {
      this.keyId = keyIdOverride.trim();
      fs.writeFileSync(this.gpgIdPath(), `${this.keyId}\n`, { mode: 0o600 });
    } else {
      // Generate a key with the master password as its passphrase.
      const params = [
        "%no-protection",
        "Key-Type: RSA",
        "Key-Length: 2048",
        "Subkey-Type: RSA",
        "Subkey-Length: 2048",
        `Name-Real: ${KEY_UID}`,
        "Expire-Date: 0",
        `Passphrase: ${masterPassword}`,
        "%commit",
        "",
      ].join("\n");
      // Actually we DO want protection; remove %no-protection by not including it.
      const paramsProtected = params.replace("%no-protection\n", "");
      const paramsFile = path.join(this.gnupgHome, "gen-key-params");
      fs.writeFileSync(paramsFile, paramsProtected, { mode: 0o600 });
      const result = await run("gpg", ["--batch", "--generate-key", paramsFile], this.env());
      try {
        fs.unlinkSync(paramsFile);
      } catch {
        // ignore
      }
      if (result.code !== 0) {
        throw new Error(`gpg key generation failed: ${result.stderr || result.stdout}`);
      }
      // Find the new key fingerprint.
      const list = await run("gpg", ["--list-keys", "--with-colons"], this.env());
      const fingerprint = this.extractFingerprint(list.stdout);
      if (!fingerprint) {
        throw new Error("could not determine the generated key fingerprint");
      }
      this.keyId = fingerprint;
      fs.writeFileSync(this.gpgIdPath(), `${this.keyId}\n`, { mode: 0o600 });
      generated = true;
    }

    // Create the probe secret so unlock() can verify the password.
    await this.writeProbe(masterPassword);
    return { generated };
  }

  private extractFingerprint(output: string): string | null {
    const lines = output.split(/\r?\n/);
    // Look for fingerprint (fpr) lines; take the last one (the new key).
    let last: string | null = null;
    for (const line of lines) {
      const fields = line.split(":");
      if (fields[0] === "fpr" && fields[9]) {
        last = fields[9];
      }
    }
    return last;
  }

  private async writeProbe(masterPassword: string): Promise<void> {
    if (!this.keyId) throw new Error("no key id");
    const probePath = path.join(this.storeDir, "remote-control", `${PROBE_NAME}.gpg`);
    fs.mkdirSync(path.dirname(probePath), { recursive: true });
    // Encrypt "ok" to the recipient.
    const enc = await run(
      "gpg",
      ["--batch", "--yes", "--encrypt", "--recipient", this.keyId, "--trust-model", "always", "--output", probePath],
      this.env(),
      "ok",
    );
    if (enc.code !== 0) {
      throw new Error(`probe encryption failed: ${enc.stderr || enc.stdout}`);
    }
    // Now verify we can decrypt with the master password (sanity).
    const dec = await run(
      "gpg",
      ["--batch", "--decrypt", "--pinentry-mode", "loopback", "--passphrase-fd", "0", probePath],
      this.env(),
      masterPassword,
    );
    if (dec.code !== 0 || dec.stdout.trim() !== "ok") {
      throw new Error(`probe verification failed: ${dec.stderr || dec.stdout}`);
    }
  }

  async unlock(masterPassword: string): Promise<{ ok: boolean }> {
    if (!this.isInitialized()) throw new VaultNotInitializedError();
    if (masterPassword.length === 0) return { ok: false };
    const probePath = path.join(this.storeDir, "remote-control", `${PROBE_NAME}.gpg`);
    if (!fs.existsSync(probePath)) {
      // No probe: accept any password (legacy). Cache it.
      this.cachePassphrase(masterPassword);
      this.touch();
      return { ok: true };
    }
    const result = await run(
      "gpg",
      ["--batch", "--decrypt", "--pinentry-mode", "loopback", "--passphrase-fd", "0", probePath],
      this.env(),
      masterPassword,
    );
    if (result.code !== 0) {
      return { ok: false };
    }
    this.cachePassphrase(masterPassword);
    this.touch();
    return { ok: true };
  }

  private cachePassphrase(password: string): void {
    // Zero any previous buffer first.
    if (this.passphrase) {
      this.passphrase.fill(0);
    }
    this.passphrase = Buffer.from(password, "utf8");
  }

  lock(): void {
    if (this.passphrase) {
      this.passphrase.fill(0);
      this.passphrase = null;
    }
    if (this.autoLockTimer) {
      clearTimeout(this.autoLockTimer);
      this.autoLockTimer = null;
    }
    // Kill the gpg-agent for this GNUPGHOME.
    void run("gpgconf", ["--kill", "gpg-agent"], this.env());
  }

  private requireUnlocked(): Buffer {
    if (!this.isUnlocked() || !this.passphrase) throw new VaultLockedError();
    this.touch();
    return this.passphrase;
  }

  private secretPath(name: string): string {
    // name may contain '/' for nested groups; sanitize traversal.
    const safe = name.replace(/\\/g, "/").split("/").filter((p) => p.length > 0 && p !== "." && p !== "..").join("/");
    if (safe.length === 0) throw new Error("invalid secret name");
    return path.join(this.storeDir, "remote-control", `${safe}.gpg`);
  }

  listEntries(prefix?: string): string[] {
    const root = path.join(this.storeDir, "remote-control");
    const result: string[] = [];
    if (!fs.existsSync(root)) return result;
    const walk = (dir: string, base: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, base);
        } else if (entry.name.endsWith(".gpg")) {
          const rel = path.relative(base, full).replace(/\.gpg$/, "");
          if (rel === PROBE_NAME) continue;
          if (prefix && !rel.startsWith(prefix)) continue;
          result.push(rel);
        }
      }
    };
    walk(root, root);
    return result.sort();
  }

  async get(name: string): Promise<string> {
    const passphrase = this.requireUnlocked();
    const file = this.secretPath(name);
    if (!fs.existsSync(file)) throw new Error(`secret not found: ${name}`);
    const result = await run(
      "gpg",
      ["--batch", "--decrypt", "--pinentry-mode", "loopback", "--passphrase-fd", "0", file],
      this.env(),
      passphrase,
    );
    if (result.code !== 0) {
      throw new Error(`decryption failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout;
  }

  async set(name: string, value: string): Promise<void> {
    if (!this.isInitialized() || !this.keyId) throw new VaultNotInitializedError();
    const file = this.secretPath(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const enc = await run(
      "gpg",
      ["--batch", "--yes", "--encrypt", "--recipient", this.keyId, "--trust-model", "always", "--output", file],
      this.env(),
      value,
    );
    if (enc.code !== 0) {
      throw new Error(`encryption failed: ${enc.stderr || enc.stdout}`);
    }
    this.touch();
  }

  async delete(name: string): Promise<boolean> {
    const file = this.secretPath(name);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    this.touch();
    return true;
  }

  /** For C3 buffer-redaction test. */
  passphraseBuffer(): Buffer | null {
    return this.passphrase;
  }
}
