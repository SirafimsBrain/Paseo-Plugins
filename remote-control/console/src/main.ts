// Transport probe page (stage A3). Runs the checks inside the real Paseo
// workspace browser and renders the outcome in the DOM (memory #7: checks
// go through DOM/JS, never screenshots).
//
// Probe matrix:
// - t1-connect: the WebSocket bridge accepts the token from the URL query.
// - t2-binary-echo: a 256-byte pattern round-trips byte-exact over binary
//   frames (the PTY framing to come in B3).
// - t3-ping-pong: JSON control frame {"t":"ping"} is answered {"t":"pong"}.
// - t4-events: the SSE fallback route /api/events streams (EventSource).
//
// The page is automated-friendly: every probe is an <li> with
// `data-test`/`data-state`/`data-detail`, a `#run-state` element settles
// into `data-state="running|pass|fail|partial"`, and `window.__rcProbeDone`
// becomes true once no probe is pending — test harnesses poll these, they
// do not screenshot.

import { openWebSocketTransport, TransportError } from "./transport";
import type { TransportSocket } from "./transport";
import { mountTerminal } from "./terminal";

const PROBE_TIMEOUT_MS = 5000;

let token = "";

function locationToken(): string {
  return new URLSearchParams(window.location.search).get("token") ?? "";
}

function wsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/term?token=${encodeURIComponent(token)}`;
}

function eventsUrl(): string {
  return `/api/events?token=${encodeURIComponent(token)}`;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function buildPattern(length: number): Uint8Array {
  const pattern = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    pattern[i] = (i * 7 + 91) & 0xff;
  }
  return pattern;
}

/** Closes the socket no matter which way the step settles. */
function finishWith(socket: TransportSocket, guard: number, settle: () => void): void {
  window.clearTimeout(guard);
  socket.close(1000, "probe done");
  settle();
}

async function probeConnect(): Promise<string> {
  const socket = await openWebSocketTransport(wsUrl(), {}, PROBE_TIMEOUT_MS);
  if (socket.readyState !== "open") {
    socket.close(1000, "probe done");
    throw new TransportError("state", "handshake resolved but socket is not open");
  }
  socket.close(1000, "probe done");
  return "reached open state";
}

async function probeBinaryEcho(): Promise<string> {
  const pattern = buildPattern(256);
  // The sink is installed before the send, so no echo can slip past it.
  let sink: ((data: Uint8Array) => void) | null = null;
  const socket = await openWebSocketTransport(wsUrl(), { onBinary: (data) => sink?.(data) }, PROBE_TIMEOUT_MS);
  return await new Promise<string>((resolve, reject) => {
    const guard = window.setTimeout(() => {
      reject(new TransportError("timeout", "no echo within 5s"));
    }, PROBE_TIMEOUT_MS);
    sink = (data) => {
      if (bytesEqual(data, pattern)) {
        finishWith(socket, guard, () => resolve(`echo ${data.byteLength} bytes byte-exact`));
        return;
      }
      finishWith(socket, guard, () => reject(new TransportError("mismatch", "echo differs byte-wise")));
    };
    socket.sendBinary(pattern);
  });
}

async function probePingPong(): Promise<string> {
  let sink: ((frame: Record<string, unknown>) => void) | null = null;
  const socket = await openWebSocketTransport(wsUrl(), { onControl: (frame) => sink?.(frame) }, PROBE_TIMEOUT_MS);
  return await new Promise<string>((resolve, reject) => {
    const guard = window.setTimeout(() => {
      reject(new TransportError("timeout", "no pong within 5s"));
    }, PROBE_TIMEOUT_MS);
    sink = (frame) => {
      if (frame.t === "pong") {
        finishWith(socket, guard, () => resolve('{"t":"ping"} → {"t":"pong"}'));
        return;
      }
      finishWith(socket, guard, () => {
        reject(new TransportError("mismatch", `unexpected control frame ${JSON.stringify(frame)}`));
      });
    };
    socket.sendControl({ t: "ping" });
  });
}

function probeEvents(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const source = new EventSource(eventsUrl());
    let settled = false;
    const guard = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      source.close();
      reject(new TransportError("timeout", "no open events within 5s"));
    }, PROBE_TIMEOUT_MS);
    const settle = (settler: () => void): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(guard);
      source.close();
      settler();
    };
    source.onopen = () => settle(() => resolve("stream opened"));
    source.onerror = () => settle(() => reject(new TransportError("sse", "eventsource error")));
  });
}

interface ProbeStep {
  id: string;
  title: string;
  run: () => Promise<string>;
}

function probes(): ProbeStep[] {
  return [
    { id: "t1-connect", title: "ws connect (token via query)", run: probeConnect },
    { id: "t2-binary-echo", title: "binary echo roundtrip", run: probeBinaryEcho },
    { id: "t3-ping-pong", title: "control ping→pong", run: probePingPong },
    { id: "t4-events", title: "SSE /api/events (fallback)", run: probeEvents },
  ];
}

function renderProbe(list: HTMLElement, step: ProbeStep): void {
  const item = document.createElement("li");
  item.dataset.test = step.id;
  item.dataset.state = "pending";
  item.dataset.refresh = "running";
  item.textContent = `${step.title} — pending`;
  list.append(item);
  void step.run().then(
    (detail) => {
      item.dataset.state = "pass";
      item.dataset.refresh = "done";
      item.dataset.detail = detail;
      item.textContent = `${step.title} — PASS (${detail})`;
      updateRunState(list);
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      item.dataset.state = "fail";
      item.dataset.refresh = "done";
      item.dataset.detail = message;
      item.textContent = `${step.title} — FAIL (${message})`;
      updateRunState(list);
    },
  );
}

function updateRunState(list: HTMLElement): void {
  const items = Array.from(list.querySelectorAll<HTMLLIElement>("li"));
  const pending = items.filter((item) => item.dataset.refresh !== "done");
  const failed = items.filter((item) => item.dataset.state === "fail");
  const container = document.getElementById("run-state");
  if (container === null) return;
  const state = pending.length > 0
    ? "running"
    : failed.length === 0
      ? "pass"
      : failed.length === items.length
        ? "fail"
        : "partial";
  container.dataset.state = state;
  if (pending.length === 0) {
    (window as unknown as { __rcProbeDone?: boolean }).__rcProbeDone = true;
  }
}

// Ghostty import (stage B1) — thin glue over the REST endpoints.
function tokenParam(): string {
  return `?token=${encodeURIComponent(token)}`;
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function previewGhostty(): Promise<void> {
  const resultEl = document.getElementById("ghostty-result");
  const applyBtn = document.getElementById("ghostty-apply") as HTMLButtonElement | null;
  if (!(resultEl instanceof HTMLElement)) return;
  try {
    const response = await fetch(`/api/ghostty/import${tokenParam()}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const preview = (await response.json()) as {
      found: boolean;
      path: string | null;
      settings: unknown;
      ignored: string[];
      errors: string[];
    };
    resultEl.textContent = pretty(preview);
    if (applyBtn) {
      applyBtn.disabled = !preview.found;
      applyBtn.dataset.settings = JSON.stringify(preview.settings);
    }
  } catch (error) {
    resultEl.textContent = `preview failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function applyGhostty(): Promise<void> {
  const resultEl = document.getElementById("ghostty-result");
  const applyBtn = document.getElementById("ghostty-apply") as HTMLButtonElement | null;
  if (!(resultEl instanceof HTMLElement) || !applyBtn) return;
  let settings: unknown = {};
  try {
    settings = JSON.parse(applyBtn.dataset.settings ?? "{}");
  } catch {
    resultEl.textContent = "no preview to apply";
    return;
  }
  try {
    const response = await fetch(`/api/ghostty/import/apply${tokenParam()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    resultEl.textContent = `applied:\n${pretty(result)}`;
  } catch (error) {
    resultEl.textContent = `apply failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function wireGhostty(): void {
  const previewBtn = document.getElementById("ghostty-preview");
  const applyBtn = document.getElementById("ghostty-apply");
  if (previewBtn instanceof HTMLButtonElement) {
    previewBtn.addEventListener("click", () => void previewGhostty());
  }
  if (applyBtn instanceof HTMLButtonElement) {
    applyBtn.addEventListener("click", () => void applyGhostty());
  }
}

// Sessions (stage B3/B4)
interface SessionInfo {
  id: string;
  kind: string;
  title: string;
  state: string;
  pid: number | null;
  exitCode: number | null;
  startedAt: number;
}

let selectedSessionId: string | null = null;
let sessionSocket: WebSocket | null = null;
let sessionTerminal: Awaited<ReturnType<typeof mountTerminal>> | null = null;

async function fetchSessions(): Promise<SessionInfo[]> {
  const response = await fetch(`/api/sessions${tokenParam()}`);
  if (!response.ok) return [];
  const body = (await response.json()) as { sessions: SessionInfo[] };
  return body.sessions ?? [];
}

function renderSessionList(sessions: SessionInfo[]): void {
  const list = document.getElementById("session-list");
  if (!(list instanceof HTMLElement)) return;
  list.replaceChildren();
  for (const session of sessions) {
    const item = document.createElement("li");
    item.style.padding = "0.25rem 0";
    item.style.cursor = "pointer";
    item.style.fontFamily = "monospace";
    item.style.fontSize = "0.85rem";
    item.textContent = `${session.id} · ${session.kind} · ${session.state} · pid ${session.pid ?? "-"}`;
    if (session.id === selectedSessionId) {
      item.style.fontWeight = "bold";
    }
    item.addEventListener("click", () => void selectSession(session.id));
    const killBtn = document.createElement("button");
    killBtn.textContent = "kill";
    killBtn.style.marginLeft = "0.5rem";
    killBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      void killSession(session.id);
    });
    item.append(killBtn);
    list.append(item);
  }
}

async function createSession(): Promise<void> {
  const response = await fetch(`/api/sessions${tokenParam()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "local" }),
  });
  if (!response.ok) return;
  const body = (await response.json()) as { session: SessionInfo };
  if (body.session) {
    await selectSession(body.session.id);
    await refreshSessions();
  }
}

async function killSession(id: string): Promise<void> {
  await fetch(`/api/sessions/${encodeURIComponent(id)}/kill${tokenParam()}`, { method: "POST" });
  if (selectedSessionId === id) {
    selectedSessionId = null;
    if (sessionSocket) {
      sessionSocket.close();
      sessionSocket = null;
    }
    if (sessionTerminal) {
      sessionTerminal.dispose();
      sessionTerminal = null;
    }
  }
  await refreshSessions();
}

async function refreshSessions(): Promise<void> {
  const sessions = await fetchSessions();
  renderSessionList(sessions);
}

async function selectSession(id: string): Promise<void> {
  selectedSessionId = id;
  const status = document.getElementById("session-status");
  if (status instanceof HTMLElement) status.textContent = `selected ${id}`;
  const container = document.getElementById("session-terminal");
  if (!(container instanceof HTMLElement)) return;

  // Tear down previous terminal/socket.
  if (sessionSocket) {
    sessionSocket.close();
    sessionSocket = null;
  }
  if (sessionTerminal) {
    sessionTerminal.dispose();
    sessionTerminal = null;
  }
  container.replaceChildren();
  sessionTerminal = await mountTerminal(container, {
    fontSize: 13,
    fontFamily: "monospace",
    cursorBlink: true,
    cursorStyle: "block",
    theme: { background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc" },
    banner: "",
  });

  const wsUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/term?token=${encodeURIComponent(token)}`;
  const socket = new WebSocket(wsUrl);
  socket.binaryType = "arraybuffer";
  sessionSocket = socket;
  socket.onopen = () => {
    socket.send(JSON.stringify({ t: "attach", sessionId: id }));
  };
  socket.onmessage = (event) => {
    const data = event.data;
    if (typeof data === "string") {
      try {
        const frame = JSON.parse(data) as { t?: string };
        if (frame.t === "exit") {
          if (status instanceof HTMLElement) status.textContent = `session ${id} exited`;
        }
      } catch {
        // ignore
      }
      return;
    }
    if (data instanceof ArrayBuffer && sessionTerminal) {
      sessionTerminal.terminal.write(new TextDecoder().decode(data));
    }
  };
  socket.onclose = () => {
    if (status instanceof HTMLElement) status.textContent = `socket closed for ${id}`;
  };
  if (sessionTerminal) {
    sessionTerminal.terminal.onData((value: string) => {
      if (sessionSocket && sessionSocket.readyState === WebSocket.OPEN) {
        sessionSocket.send(new TextEncoder().encode(value));
      }
    });
    sessionTerminal.fitAddon.observeResize();
  }
}

function wireSessions(): void {
  const newBtn = document.getElementById("session-new");
  if (newBtn instanceof HTMLButtonElement) {
    newBtn.addEventListener("click", () => void createSession());
  }
  void refreshSessions();
  // Keep the list fresh via SSE.
  try {
    const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    source.addEventListener("message", () => void refreshSessions());
    // session-updated is sent as a named event
    source.addEventListener("session-updated", () => void refreshSessions());
  } catch {
    // ignore
  }
}

function main(): void {
  token = locationToken();
  const list = document.getElementById("transport-probe");
  if (list instanceof HTMLElement) {
    const runState = document.createElement("div");
    runState.id = "run-state";
    runState.dataset.state = "running";
    list.before(runState);
    for (const step of probes()) {
      renderProbe(list, step);
    }
  }
  wireGhostty();
  wireSessions();

  const terminalContainer = document.getElementById("terminal");
  if (terminalContainer instanceof HTMLElement) {
    void mountTerminal(terminalContainer, {
      fontSize: 14,
      fontFamily: "monospace",
      cursorBlink: true,
      cursorStyle: "block",
      theme: { background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc" },
      banner: "remote-control console (ghostty-web) — stage B2\r\n",
    }).catch((error) => {
      terminalContainer.textContent = `terminal failed to mount: ${error instanceof Error ? error.message : String(error)}`;
    });
  }
}

main();
