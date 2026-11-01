import { describe, expect, it } from "vitest";
import { parseScreenParams, screenParams, toOpenScreenParams } from "../shared/screen-params";

describe("screen params deep links", () => {
  it("defaults to the library view with no focus", () => {
    expect(parseScreenParams(undefined)).toEqual({ view: "library", commandId: null, scheduleId: null });
    expect(parseScreenParams({})).toEqual({ view: "library", commandId: null, scheduleId: null });
  });

  it("accepts every known view and rejects unknown ones", () => {
    expect(parseScreenParams({ view: "history" }).view).toBe("history");
    expect(parseScreenParams({ view: "schedules" }).view).toBe("schedules");
    expect(parseScreenParams({ view: "library" }).view).toBe("library");
    expect(parseScreenParams({ view: "bogus" }).view).toBe("library");
  });

  it("trims focus ids and treats empty ones as no focus", () => {
    const parsed = parseScreenParams({ view: "library", command: "  cmd_7  ", schedule: "" });
    expect(parsed.commandId).toBe("cmd_7");
    expect(parsed.scheduleId).toBeNull();
  });

  it("ignores unknown keys", () => {
    expect(parseScreenParams({ view: "schedules", extra: "x" })).toEqual({
      view: "schedules",
      commandId: null,
      scheduleId: null,
    });
  });

  it("round-trips through the openScreen payload", () => {
    const original = screenParams("schedules", { scheduleId: "sch_1" });
    const payload = toOpenScreenParams(original);
    expect(payload).toEqual({ view: "schedules", schedule: "sch_1" });
    expect(parseScreenParams(payload)).toEqual(original);
  });

  it("omits empty focus ids from the payload", () => {
    expect(toOpenScreenParams(screenParams("library"))).toEqual({ view: "library" });
  });
});
