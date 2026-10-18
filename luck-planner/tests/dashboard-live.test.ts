import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_COALESCE_MS,
  createChangeStream,
  mergeChanges,
  parseReadyEvent,
  parseTreeChangedEvent,
  type ChangeStreamStatus,
  type SseSource,
  type SseSourceFactory,
} from "../dashboard/src/live";
import {
  changesTouchNode,
  type TreeChangedEvent,
} from "../shared/api";

/**
 * Stage H1 acceptance (`PLAN.md`): the dashboard's side of the change stream.
 *
 * The browser tab must turn server events into the *right* number of refetches
 * — one per burst, not one per row — tell a live stream from a dead one, and
 * survive a payload it cannot parse. Those are the rules pinned here, over an
 * injected `EventSource` stand-in so the test needs no browser and no socket.
 */

const P = "/projects/demo";

interface StubSource extends SseSource {
  url: string;
  closed: boolean;
  emit(type: string, data: string): void;
}

/** Records the sources it hands out and lets a test play events into them. */
function stubFactory(): { factory: SseSourceFactory; sources: StubSource[] } {
  const sources: StubSource[] = [];
  const factory: SseSourceFactory = (url) => {
    const listeners = new Map<string, Array<(event: { data: string }) => void>>();
    const source: StubSource = {
      url,
      closed: false,
      addEventListener(type, listener) {
        const bucket = listeners.get(type) ?? [];
        bucket.push(listener);
        listeners.set(type, bucket);
      },
      close() {
        source.closed = true;
      },
      emit(type, data) {
        for (const listener of listeners.get(type) ?? []) listener({ data });
      },
    };
    sources.push(source);
    return source;
  };
  return { factory, sources };
}

/** A valid `tree-changed` payload with one audit row per given entity id. */
function changed(
  entityIds: string[],
  options: { watermark?: number; entityType?: string; projectKey?: string } = {},
): string {
  const watermark = options.watermark ?? 10;
  return JSON.stringify({
    projectKey: options.projectKey ?? P,
    watermark,
    changes: entityIds.map((entityId, index) => ({
      id: watermark + index,
      projectKey: options.projectKey ?? P,
      entityType: options.entityType ?? "node",
      entityId,
      action: "update",
      revision: 2,
      actor: "agent:coder",
      result: "",
      at: 1_700_000_000_000,
    })),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("payload decoding", () => {
  it("accepts a well-formed tree-changed event and rejects the rest", () => {
    const id = randomUUID();
    const parsed = parseTreeChangedEvent(changed([id]));
    expect(parsed?.projectKey).toBe(P);
    expect(parsed?.changes.map((change) => change.entityId)).toEqual([id]);

    // Not JSON, an empty change list, a wrong entity type, a bad uuid.
    expect(parseTreeChangedEvent("{oops")).toBeNull();
    expect(parseTreeChangedEvent("{}")).toBeNull();
    expect(parseTreeChangedEvent(changed([], { watermark: 1 }))).toBeNull();
    expect(parseTreeChangedEvent(changed([id], { entityType: "unknown" }))).toBeNull();
    expect(parseTreeChangedEvent(changed(["not-a-uuid"]))).toBeNull();
  });
  it("reads the ready payload the server opens the stream with", () => {
    expect(parseReadyEvent('{"version":"0.24.0","watermark":42}')).toEqual({
      version: "0.24.0",
      watermark: 42,
    });
    expect(parseReadyEvent("{}")).toBeNull();
    expect(parseReadyEvent("nope")).toBeNull();
  });

  it("merges a burst: every row, the highest watermark", () => {
    const first = parseTreeChangedEvent(changed([randomUUID()], { watermark: 3 }))!;
    const second = parseTreeChangedEvent(changed([randomUUID(), randomUUID()], { watermark: 9 }))!;
    const merged = mergeChanges([first, second]);
    expect(merged.projectKey).toBe(P);
    expect(merged.watermark).toBe(9);
    expect(merged.changes).toHaveLength(3);
  });
});

describe("changesTouchNode (the rule both live consumers share)", () => {
  it("refreshes for the node itself, not for an unrelated node", () => {
    const mine = randomUUID();
    const other = randomUUID();
    const nodeRow = (entityId: string) => ({
      entityId,
      entityType: "node" as const,
    });
    expect(changesTouchNode([nodeRow(mine)], mine)).toBe(true);
    expect(changesTouchNode([nodeRow(other)], mine)).toBe(false);
    expect(changesTouchNode([], mine)).toBe(false);
  });

  it("refreshes for anything linked to nodes, whatever it is", () => {
    const mine = randomUUID();
    for (const entityType of ["bee", "bug", "goal", "growth"] as const) {
      // A link row carries its own id; it still belongs to the node view.
      expect(changesTouchNode([{ entityId: randomUUID(), entityType }], mine)).toBe(true);
    }
  });
});

describe("createChangeStream", () => {
  it("subscribes to the given URL and reports live/offline with the cursor", () => {
    const { factory, sources } = stubFactory();
    const states: ChangeStreamStatus[] = [];
    const stream = createChangeStream({
      url: `/api/events?token=t&project=${encodeURIComponent(P)}`,
      factory,
      onTreeChanged: () => {},
      onStatus: (status) => states.push(status),
    });
    try {
      expect(sources).toHaveLength(1);
      expect(sources[0].url).toContain("/api/events");

      sources[0].emit("ready", JSON.stringify({ version: "0.24.0", watermark: 7 }));
      expect(states.at(-1)).toEqual({ state: "live", watermark: 7 });

      // A dropped socket is reported, and the browser retries on its own.
      sources[0].emit("error", "");
      expect(states.at(-1)).toEqual({ state: "offline", watermark: null });
    } finally {
      stream.close();
    }
  });

  it("coalesces a burst of events into one callback with every row", () => {
    vi.useFakeTimers();
    const { factory, sources } = stubFactory();
    const events: TreeChangedEvent[] = [];
    const stream = createChangeStream({
      url: "/api/events",
      factory,
      onTreeChanged: (event) => events.push(event),
    });
    try {
      const first = randomUUID();
      const second = randomUUID();
      sources[0].emit("tree-changed", changed([first], { watermark: 1 }));
      sources[0].emit("tree-changed", changed([second], { watermark: 2 }));

      // Nothing yet: the burst is still open.
      expect(events).toHaveLength(0);
      vi.advanceTimersByTime(DEFAULT_COALESCE_MS);

      expect(events).toHaveLength(1);
      expect(events[0].changes.map((change) => change.entityId)).toEqual([first, second]);
      expect(events[0].watermark).toBe(2);
    } finally {
      stream.close();
    }
  });

  it("still reports a change when the payload makes no sense", () => {
    vi.useFakeTimers();
    const { factory, sources } = stubFactory();
    const events: TreeChangedEvent[] = [];
    const stream = createChangeStream({
      url: "/api/events",
      factory,
      onTreeChanged: (event) => events.push(event),
    });
    try {
      // A tab left open across a plugin update: the shape moved on, but the
      // *fact* that something changed must still reach the app.
      sources[0].emit("tree-changed", '{"shape":"from the future"}');
      vi.advanceTimersByTime(DEFAULT_COALESCE_MS);
      expect(events).toHaveLength(1);
      expect(events[0].changes).toEqual([]);
    } finally {
      stream.close();
    }
  });

  it("delivers nothing after close and closes the source", () => {
    vi.useFakeTimers();
    const { factory, sources } = stubFactory();
    const events: TreeChangedEvent[] = [];
    const stream = createChangeStream({
      url: "/api/events",
      factory,
      onTreeChanged: (event) => events.push(event),
    });
    sources[0].emit("tree-changed", changed([randomUUID()]));
    stream.close();
    expect(sources[0].closed).toBe(true);

    vi.advanceTimersByTime(DEFAULT_COALESCE_MS * 4);
    sources[0].emit("tree-changed", changed([randomUUID()]));
    vi.advanceTimersByTime(DEFAULT_COALESCE_MS * 4);
    expect(events).toEqual([]);
  });

  it("degrades to a visible offline state where EventSource does not exist", () => {
    const states: ChangeStreamStatus[] = [];
    const stream = createChangeStream({
      url: "/api/events",
      onTreeChanged: () => {},
      onStatus: (status) => states.push(status),
    });
    try {
      // Node has no EventSource: the dashboard must still render its data.
      expect(states).toEqual([{ state: "offline", watermark: null }]);
    } finally {
      stream.close();
    }
  });
});
