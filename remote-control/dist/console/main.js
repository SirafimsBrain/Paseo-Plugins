// console/src/transport.ts
var TransportError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
async function openWebSocketTransport(url, hooks, timeoutMs = 5e3) {
  let socket;
  try {
    socket = new WebSocket(url);
  } catch (cause) {
    hooks.onError?.(cause);
    throw new TransportError("construct", String(cause));
  }
  socket.binaryType = "arraybuffer";
  return await new Promise((resolve, reject) => {
    const guard = window.setTimeout(() => {
      hooks.onError?.(new TransportError("timeout", `no open within ${timeoutMs}ms`));
      try {
        socket.close();
      } catch {
      }
      reject(new TransportError("timeout", `no open within ${timeoutMs}ms`));
    }, timeoutMs);
    socket.onopen = () => {
      if (guard !== null) window.clearTimeout(guard);
      hooks.onOpen?.();
      resolve({
        get readyState() {
          switch (socket.readyState) {
            case WebSocket.CONNECTING:
              return "connecting";
            case WebSocket.OPEN:
              return "open";
            case WebSocket.CLOSING:
              return "closing";
            default:
              return "closed";
          }
        },
        sendBinary(data) {
          socket.send(data);
        },
        sendControl(frame) {
          socket.send(JSON.stringify(frame));
        },
        close(code, reason) {
          socket.close(code ?? 1e3, reason);
        }
      });
    };
    socket.onclose = (event) => {
      if (guard !== null) window.clearTimeout(guard);
      hooks.onClose?.({ code: event.code, reason: event.reason });
    };
    socket.onerror = (event) => {
      hooks.onError?.(event);
    };
    socket.onmessage = (event) => {
      const data = event.data;
      if (typeof data === "string") {
        let frame;
        try {
          frame = JSON.parse(data);
        } catch {
          hooks.onControl?.({ t: "error", code: "bad-json" });
          return;
        }
        if (frame && typeof frame === "object") {
          hooks.onControl?.(frame);
        }
        return;
      }
      if (data instanceof ArrayBuffer) {
        hooks.onBinary?.(new Uint8Array(data));
        return;
      }
      if (typeof Blob !== "undefined" && data instanceof Blob) {
        void data.arrayBuffer().then((buffer) => hooks.onBinary?.(new Uint8Array(buffer)));
      }
    };
  });
}

// console/src/main.ts
var PROBE_TIMEOUT_MS = 5e3;
var token = "";
function locationToken() {
  return new URLSearchParams(window.location.search).get("token") ?? "";
}
function wsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/term?token=${encodeURIComponent(token)}`;
}
function eventsUrl() {
  return `/api/events?token=${encodeURIComponent(token)}`;
}
function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
function buildPattern(length) {
  const pattern = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    pattern[i] = i * 7 + 91 & 255;
  }
  return pattern;
}
function finishWith(socket, guard, settle) {
  window.clearTimeout(guard);
  socket.close(1e3, "probe done");
  settle();
}
async function probeConnect() {
  const socket = await openWebSocketTransport(wsUrl(), {}, PROBE_TIMEOUT_MS);
  if (socket.readyState !== "open") {
    socket.close(1e3, "probe done");
    throw new TransportError("state", "handshake resolved but socket is not open");
  }
  socket.close(1e3, "probe done");
  return "reached open state";
}
async function probeBinaryEcho() {
  const pattern = buildPattern(256);
  let sink = null;
  const socket = await openWebSocketTransport(wsUrl(), { onBinary: (data) => sink?.(data) }, PROBE_TIMEOUT_MS);
  return await new Promise((resolve, reject) => {
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
async function probePingPong() {
  let sink = null;
  const socket = await openWebSocketTransport(wsUrl(), { onControl: (frame) => sink?.(frame) }, PROBE_TIMEOUT_MS);
  return await new Promise((resolve, reject) => {
    const guard = window.setTimeout(() => {
      reject(new TransportError("timeout", "no pong within 5s"));
    }, PROBE_TIMEOUT_MS);
    sink = (frame) => {
      if (frame.t === "pong") {
        finishWith(socket, guard, () => resolve('{"t":"ping"} \u2192 {"t":"pong"}'));
        return;
      }
      finishWith(socket, guard, () => {
        reject(new TransportError("mismatch", `unexpected control frame ${JSON.stringify(frame)}`));
      });
    };
    socket.sendControl({ t: "ping" });
  });
}
function probeEvents() {
  return new Promise((resolve, reject) => {
    const source = new EventSource(eventsUrl());
    let settled = false;
    const guard = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      source.close();
      reject(new TransportError("timeout", "no open events within 5s"));
    }, PROBE_TIMEOUT_MS);
    const settle = (settler) => {
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
function probes() {
  return [
    { id: "t1-connect", title: "ws connect (token via query)", run: probeConnect },
    { id: "t2-binary-echo", title: "binary echo roundtrip", run: probeBinaryEcho },
    { id: "t3-ping-pong", title: "control ping\u2192pong", run: probePingPong },
    { id: "t4-events", title: "SSE /api/events (fallback)", run: probeEvents }
  ];
}
function renderProbe(list, step) {
  const item = document.createElement("li");
  item.dataset.test = step.id;
  item.dataset.state = "pending";
  item.dataset.refresh = "running";
  item.textContent = `${step.title} \u2014 pending`;
  list.append(item);
  void step.run().then(
    (detail) => {
      item.dataset.state = "pass";
      item.dataset.refresh = "done";
      item.dataset.detail = detail;
      item.textContent = `${step.title} \u2014 PASS (${detail})`;
      updateRunState(list);
    },
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      item.dataset.state = "fail";
      item.dataset.refresh = "done";
      item.dataset.detail = message;
      item.textContent = `${step.title} \u2014 FAIL (${message})`;
      updateRunState(list);
    }
  );
}
function updateRunState(list) {
  const items = Array.from(list.querySelectorAll("li"));
  const pending = items.filter((item) => item.dataset.refresh !== "done");
  const failed = items.filter((item) => item.dataset.state === "fail");
  const container = document.getElementById("run-state");
  if (container === null) return;
  const state = pending.length > 0 ? "running" : failed.length === 0 ? "pass" : failed.length === items.length ? "fail" : "partial";
  container.dataset.state = state;
  if (pending.length === 0) {
    window.__rcProbeDone = true;
  }
}
function main() {
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
