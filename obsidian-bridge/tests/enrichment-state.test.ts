import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EMPTY_EVENT_STATE,
  enrichmentStatePath,
  readEnrichmentState,
  writeEnrichmentState,
} from "../server/enrichment-state";

/**
 * The MCP server has no event subscription of its own, so `obsidian_status`
 * reports the state the plugin publishes here.
 */

const previousHome = process.env.PASEO_HOME;
const homes: string[] = [];

function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obb-state-"));
  homes.push(dir);
  process.env.PASEO_HOME = dir;
  return dir;
}

afterEach(() => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("enrichment event state", () => {
  it("round-trips what the plugin published", () => {
    home();
    writeEnrichmentState({ events: true, lastEventAt: "2026-11-14T12:16:18.585Z" });
    expect(readEnrichmentState()).toEqual({
      events: true,
      lastEventAt: "2026-11-14T12:16:18.585Z",
    });
  });

  it("writes into the plugin data directory, not the checkout", () => {
    const dir = home();
    writeEnrichmentState({ events: true, lastEventAt: null });
    expect(enrichmentStatePath()).toBe(
      path.join(dir, "plugins", "obsidian-bridge", "enrichment-state.json"),
    );
  });

  it("reports nothing live before the plugin publishes", () => {
    home();
    expect(readEnrichmentState()).toEqual(EMPTY_EVENT_STATE);
  });

  it("survives a corrupt or hostile record", () => {
    home();
    const target = enrichmentStatePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    for (const body of ["not json", "[]", '{"events":"yes","lastEventAt":5}']) {
      fs.writeFileSync(target, body, "utf-8");
      expect(readEnrichmentState()).toEqual(EMPTY_EVENT_STATE);
    }
  });
});
