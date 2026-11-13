import { spawn, type ChildProcess } from "node:child_process";
import { resolveEmbedWorker, resolveNodeCommand } from "../mcp-launch";

/**
 * Plugin-side controller for the short-lived embedding process.
 *
 * It owns no model and no vectors: it spawns `embed-worker.js`, forwards its
 * progress into `obsidian-bridge.status`, and makes sure only one job runs at a
 * time. Being a separate process, its ~1 GB peak leaves with it.
 */

export type EmbedJobStateName = "idle" | "running" | "done" | "error";

export interface EmbedJobState {
  state: EmbedJobStateName;
  done: number;
  total: number;
  rssMb: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface EmbedJobOptions {
  dbPath: string;
  model: string;
  dtype: string;
  cacheDir: string;
  stemming: boolean;
}

const IDLE: EmbedJobState = {
  state: "idle",
  done: 0,
  total: 0,
  rssMb: null,
  error: null,
  startedAt: null,
  finishedAt: null,
};

export class EmbedJob {
  private child: ChildProcess | null = null;
  private buffer = "";
  private current: EmbedJobState = { ...IDLE };

  get running(): boolean {
    return this.child !== null;
  }

  snapshot(): EmbedJobState {
    return { ...this.current };
  }

  start(options: EmbedJobOptions): boolean {
    if (this.child) return false;
    this.current = {
      state: "running",
      done: 0,
      total: 0,
      rssMb: null,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.buffer = "";

    let child: ChildProcess;
    try {
      child = spawn(resolveNodeCommand(), [resolveEmbedWorker()], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          OBSIDIAN_BRIDGE_DB: options.dbPath,
          OBSIDIAN_BRIDGE_MODEL: options.model,
          OBSIDIAN_BRIDGE_DTYPE: options.dtype,
          OBSIDIAN_BRIDGE_CACHE: options.cacheDir,
          OBSIDIAN_BRIDGE_STEMMING: options.stemming ? "1" : "0",
        },
      });
    } catch (cause) {
      this.current = {
        ...this.current,
        state: "error",
        error: cause instanceof Error ? cause.message : String(cause),
        finishedAt: new Date().toISOString(),
      };
      return false;
    }

    this.child = child;
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => this.consume(chunk));
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      const text = String(chunk).trim();
      if (text.length > 0) console.warn(`[obsidian-bridge] embed: ${text}`);
    });
    child.once("error", (cause) => {
      this.current = {
        ...this.current,
        state: "error",
        error: cause.message,
        finishedAt: new Date().toISOString(),
      };
      this.child = null;
    });
    child.once("exit", (code) => {
      this.child = null;
      const finished = new Date().toISOString();
      if (this.current.state === "running") {
        this.current = {
          ...this.current,
          state: code === 0 ? "done" : "error",
          error:
            code === 0
              ? null
              : (this.current.error ?? `Embedding process exited with code ${String(code)}.`),
          finishedAt: finished,
        };
      }
    });
    return true;
  }

  stop(): void {
    if (!this.child) return;
    this.child.kill("SIGTERM");
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const state = message.state;
      if (state === "error") {
        this.current = {
          ...this.current,
          state: "error",
          error: typeof message.error === "string" ? message.error : "Embedding failed.",
          finishedAt: new Date().toISOString(),
        };
        continue;
      }
      this.current = {
        ...this.current,
        state: state === "done" ? "done" : "running",
        done: typeof message.done === "number" ? message.done : this.current.done,
        total: typeof message.total === "number" ? message.total : this.current.total,
        rssMb: typeof message.rssMb === "number" ? message.rssMb : this.current.rssMb,
        error: state === "done" ? null : this.current.error,
      };
    }
  }
}
