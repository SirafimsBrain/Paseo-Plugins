import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCommandEvents,
  notifyCommandEventListeners,
  publishCommandEvent,
  recentCommandEvents,
  subscribeCommandEvents,
} from "../server/event-bus";
import { EVENT_FEED_LIMIT, commandEventSchema, eventsStream } from "../shared/events";

describe("command event feed", () => {
  beforeEach(() => {
    clearCommandEvents();
  });

  it("keeps the newest event first and labels it", () => {
    const first = publishCommandEvent({ kind: "run", title: "Review", detail: "agent a1", ok: true });
    const second = publishCommandEvent({ kind: "schedule", title: "Nightly", detail: "paused" });
    expect(recentCommandEvents().map((event) => event.id)).toEqual([second.id, first.id]);
    expect(second.ok).toBeNull();
    expect(first.ok).toBe(true);
    expect(() => commandEventSchema.parse(first)).not.toThrow();
  });

  it("bounds the feed without dropping the newest entries", () => {
    for (let index = 0; index < EVENT_FEED_LIMIT + 5; index += 1) {
      publishCommandEvent({ kind: "run", title: `run ${index}`, detail: "" });
    }
    const feed = recentCommandEvents();
    expect(feed).toHaveLength(EVENT_FEED_LIMIT);
    expect(feed[0]!.title).toBe(`run ${EVENT_FEED_LIMIT + 4}`);
  });

  it("honours a smaller limit", () => {
    publishCommandEvent({ kind: "run", title: "a", detail: "" });
    publishCommandEvent({ kind: "run", title: "b", detail: "" });
    expect(recentCommandEvents(1)).toHaveLength(1);
    expect(recentCommandEvents(1)[0]!.title).toBe("b");
    expect(recentCommandEvents(0)).toHaveLength(0);
  });

  it("notifies subscribers with the event and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCommandEvents(listener);
    const event = publishCommandEvent({ kind: "provisioning", title: "a1", detail: "mcp", ok: true });
    expect(listener).toHaveBeenCalledWith(event);
    unsubscribe();
    publishCommandEvent({ kind: "run", title: "after", detail: "" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("wakes listeners without inventing an event", () => {
    const listener = vi.fn();
    subscribeCommandEvents(listener);
    notifyCommandEventListeners();
    expect(listener).toHaveBeenCalledWith(null);
    expect(recentCommandEvents()).toHaveLength(0);
  });

  it("declares the subscription contract the client subscribes to", () => {
    expect(eventsStream.name).toBe("command-center.events");
    expect(eventsStream.input.parse({})).toEqual({});
    expect(() =>
      eventsStream.event.parse({ at: new Date().toISOString(), event: null, recent: [] }),
    ).not.toThrow();
  });
});
