import { beforeEach, describe, expect, it } from "vitest";
import { requestFocus, subscribeFocus, takePendingFocus } from "../client/focus";

/**
 * The deep-link focus handoff (`__doc.md` §10.8 item 5). Paseo 0.14.0's
 * `openPanel` carries no params channel (`PluginWorkspacePanelParams` is an
 * empty interface), so `/luck-status`, `/luck-bug` and the Command Center
 * item deliver their focus request through this module mailbox instead. The
 * contract:
 *
 * - a request wakes every subscribed panel; the panel then **pulls** it (a
 *   stale subscriber cannot consume anything by accident);
 * - the request survives until a panel takes it — a command run with the
 *   panel closed still lands on its record when the panel opens;
 * - taking is one-shot, and a request for another project is dropped, not
 *   leaked into the next mount (project keys are canonical, ADR-2).
 */

beforeEach(() => {
  // Module-level singleton: drain the pending slot between tests.
  takePendingFocus("__drain__");
});

describe("focus handoff", () => {
  it("wakes a subscribed panel, which then pulls the request", () => {
    let woken = 0;
    const off = subscribeFocus(() => {
      woken += 1;
    });
    try {
      requestFocus("/projects/a", "n-1");
      expect(woken).toBe(1);
      expect(takePendingFocus("/projects/a")).toEqual({
        projectKey: "/projects/a",
        nodeId: "n-1",
      });
    } finally {
      off();
    }
  });

  it("keeps the request until a panel pulls it (closed panel case)", () => {
    requestFocus("/projects/a", "n-1");
    expect(takePendingFocus("/projects/a")).toEqual({
      projectKey: "/projects/a",
      nodeId: "n-1",
    });
    expect(takePendingFocus("/projects/a")).toBeNull(); // one-shot
  });

  it("coalesces a burst to the newest request", () => {
    requestFocus("/projects/a", "n-1");
    requestFocus("/projects/a", "n-2");
    expect(takePendingFocus("/projects/a")).toEqual({
      projectKey: "/projects/a",
      nodeId: "n-2",
    });
  });

  it("drops — never leaks — another project's request", () => {
    requestFocus("/projects/a", "n-1");
    expect(takePendingFocus("/projects/b")).toBeNull();
    expect(takePendingFocus("/projects/a")).toBeNull(); // cleared, not delivered later
  });

  it("wakes every subscribed panel", () => {
    let first = 0;
    let second = 0;
    const offA = subscribeFocus(() => {
      first += 1;
    });
    const offB = subscribeFocus(() => {
      second += 1;
    });
    try {
      requestFocus("/projects/a", "n-1");
      expect(first).toBe(1);
      expect(second).toBe(1);
    } finally {
      offA();
      offB();
    }
  });

  it("an unsubscribed panel is not woken, but the request stays parked", () => {
    let woken = 0;
    const off = subscribeFocus(() => {
      woken += 1;
    });
    off();
    requestFocus("/projects/a", "n-1");
    expect(woken).toBe(0);
    expect(takePendingFocus("/projects/a")).toEqual({
      projectKey: "/projects/a",
      nodeId: "n-1",
    });
  });

  it("survives a double unsubscribe (React StrictMode parity)", () => {
    let woken = 0;
    const off = subscribeFocus(() => {
      woken += 1;
    });
    off();
    off(); // the second call must not remove anyone else
    const off2 = subscribeFocus(() => {
      woken += 1;
    });
    try {
      requestFocus("/projects/a", "n-1");
      expect(woken).toBe(1);
    } finally {
      off2();
    }
  });
});
