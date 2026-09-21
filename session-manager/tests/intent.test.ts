import { describe, expect, it, vi } from "vitest";
import {
  clearSessionManagerIntent,
  getSessionManagerIntent,
  setSessionManagerIntent,
  subscribeSessionManagerIntent,
} from "../client/intent";

describe("session manager intent store", () => {
  it("starts empty", () => {
    expect(getSessionManagerIntent()).toBeNull();
  });

  it("hands the intent over to the panel and clears it", () => {
    setSessionManagerIntent({ ageDays: 30, selectShown: true });

    expect(getSessionManagerIntent()).toEqual({ ageDays: 30, selectShown: true });

    clearSessionManagerIntent();
    expect(getSessionManagerIntent()).toBeNull();
    // Clearing twice must not notify anyone a second time.
    const listener = vi.fn();
    const unsubscribe = subscribeSessionManagerIntent(listener);
    clearSessionManagerIntent();
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("notifies subscribers about every change and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionManagerIntent(listener);

    setSessionManagerIntent({ archivedOnly: true });
    expect(listener).toHaveBeenCalledTimes(1);
    clearSessionManagerIntent();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setSessionManagerIntent({ ageDays: 1 });
    expect(listener).toHaveBeenCalledTimes(2);
    clearSessionManagerIntent();
  });
});
