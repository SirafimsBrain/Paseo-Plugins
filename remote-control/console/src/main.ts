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

function main(): void {
  token = locationToken();
  const list = document.getElementById("transport-probe");
  if (!(list instanceof HTMLElement)) return;
  const runState = document.createElement("div");
  runState.id = "run-state";
  runState.dataset.state = "running";
  list.before(runState);
  for (const step of probes()) {
    renderProbe(list, step);
  }
}

main();
