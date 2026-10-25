// Client side of the terminal bridge transport (stage A3, ADR-6).
//
// `openWebSocketTransport` is the winning transport. The SSE+POST variant
// is a documented stub: it exists so that a transport swap (if the Paseo
// workspace browser ever refuses WebSockets) only touches this file and
// `server/transport.ts`. The decision and the probe evidence live in
// `__doc.md` § Transport.
//
// Frame contract mirrors the server (§5.3): binary frames carry raw PTY
// bytes, text frames carry JSON control messages. The client keeps the two
// framings apart, so terminal output is never confused with control data.

export interface TransportHooks {
  onOpen?(): void;
  onClose?(event: { code: number; reason: string }): void;
  onBinary?(data: Uint8Array): void;
  onControl?(frame: Record<string, unknown>): void;
  onError?(error: unknown): void;
}

export interface TransportSocket {
  sendBinary(data: Uint8Array): void;
  sendControl(frame: Record<string, unknown>): void;
  close(code?: number, reason?: string): void;
  readonly readyState: "connecting" | "open" | "closing" | "closed";
}

export class TransportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function toTransferable(buffer: Uint8Array): Uint8Array {
  // A plain copy: WebSocket.send accepts BufferSource, and callers hand us
  // views of shared buffers in later stages — do not alias them.
  return new Uint8Array(buffer);
}

export async function openWebSocketTransport(
  url: string,
  hooks: TransportHooks,
  timeoutMs = 5000,
): Promise<TransportSocket> {
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch (cause) {
    hooks.onError?.(cause);
    throw new TransportError("construct", String(cause));
  }
  socket.binaryType = "arraybuffer";

  return await new Promise<TransportSocket>((resolve, reject) => {
    const guard: number | null = window.setTimeout(() => {
      hooks.onError?.(new TransportError("timeout", `no open within ${timeoutMs}ms`));
      try {
        socket.close();
      } catch {
        // ignore
      }
      reject(new TransportError("timeout", `no open within ${timeoutMs}ms`));
    }, timeoutMs);

    socket.onopen = () => {
      if (guard !== null) window.clearTimeout(guard);
      hooks.onOpen?.();
      resolve({
        get readyState(): "connecting" | "open" | "closing" | "closed" {
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
          socket.close(code ?? 1000, reason);
        },
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
      const data: unknown = event.data;
      if (typeof data === "string") {
        let frame: unknown;
        try {
          frame = JSON.parse(data);
        } catch {
          hooks.onControl?.({ t: "error", code: "bad-json" });
          return;
        }
        if (frame && typeof frame === "object") {
          hooks.onControl?.(frame as Record<string, unknown>);
        }
        return;
      }
      if (data instanceof ArrayBuffer) {
        hooks.onBinary?.(new Uint8Array(data));
        return;
      }
      if (typeof Blob !== "undefined" && data instanceof Blob) {
        void data
          .arrayBuffer()
          .then((buffer) => hooks.onBinary?.(new Uint8Array(buffer)));
      }
    };
  });
}

/**
 * Fallback placeholder (SSE receive + POST send). Not implemented: the
 * WebSocket probe won. Kept here so the feature gap stays explicit.
 */
export class SsePostTransportStub {
  readonly kind = "sse-post" as const;

  constructor() {
    throw new TransportError(
      "stub",
      "SSE+POST transport is not implemented; WebSocket won the A3 spike",
    );
  }
}
