import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canvasFromMarkdown, canvasToMarkdown, layoutCanvas, normalizeCanvasPath, parseCanvasText, validateCanvas } from "../server/canvas/model";
import { dispatchTool } from "../server/mcp-tools";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";

/**
 * JSON Canvas support (0.27.25): the format, the boundary and the tool surface.
 *
 * The tools are native — no package is installed for them — so these cases are
 * the specification: what a canvas document must look like, which paths are
 * refused, and what one edit does to the rest of the file.
 */

const workspaces: TestWorkspace[] = [];

afterEach(() => {
  while (workspaces.length > 0) workspaces.pop()?.cleanup();
});

function workspace(extra: Record<string, string> = {}): TestWorkspace {
  const created = makeWorkspace(extra);
  workspaces.push(created);
  return created;
}

function readFile(created: TestWorkspace, relPath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(created.vault, relPath), "utf-8")) as Record<string, unknown>;
}

describe("canvas format", () => {
  it("validates the JSON Canvas 1.0 shape and names the offending node", () => {
    const good = validateCanvas({
      nodes: [{ id: "a", type: "text", text: "hello", x: 0, y: 0, width: 250, height: 60 }],
      edges: [],
    });
    expect("canvas" in good).toBe(true);

    const badType = validateCanvas({ nodes: [{ id: "a", type: "sticky", x: 0, y: 0, width: 1, height: 1 }] });
    expect("error" in badType && badType.error).toContain("node 0");
    expect("error" in badType && badType.error).toContain("text, file, link, group");

    const dangling = validateCanvas({
      nodes: [{ id: "a", type: "text", text: "x", x: 0, y: 0, width: 10, height: 10 }],
      edges: [{ id: "e", fromNode: "a", toNode: "missing" }],
    });
    expect("error" in dangling && dangling.error).toContain("'missing'");
  });

  it("reports invalid JSON instead of throwing", () => {
    const parsed = parseCanvasText("{not json");
    expect("error" in parsed && parsed.error).toContain("not valid JSON");
  });

  it("normalizes the path, appending the extension and refusing escapes", () => {
    expect(normalizeCanvasPath("Projects/Map")).toEqual({ path: "Projects/Map.canvas" });
    expect(normalizeCanvasPath("./Map.canvas")).toEqual({ path: "Map.canvas" });
    expect("error" in normalizeCanvasPath("../outside")).toBe(true);
    expect("error" in normalizeCanvasPath(".obsidian/workspace")).toBe(true);
    expect("error" in normalizeCanvasPath("Projects/_archive/old")).toBe(true);
    expect("error" in normalizeCanvasPath("   ")).toBe(true);
  });

  it("keeps fields it does not know when it rewrites the file", () => {
    const parsed = validateCanvas({
      nodes: [{ id: "a", type: "text", text: "x", x: 0, y: 0, width: 10, height: 10, futureField: 42 }],
      edges: [],
      futureTopLevel: true,
    });
    expect("canvas" in parsed).toBe(true);
    if ("error" in parsed) return;
    expect((parsed.canvas.nodes[0] as Record<string, unknown>).futureField).toBe(42);
    expect(parsed.canvas.extra.futureTopLevel).toBe(true);
  });

  it("orders a roadmap by the edge graph and a hub around the first node", () => {
    const canvas = validateCanvas({
      nodes: [
        { id: "c", type: "text", text: "c", x: 9, y: 9, width: 100, height: 50 },
        { id: "a", type: "text", text: "a", x: 9, y: 9, width: 100, height: 50 },
        { id: "b", type: "text", text: "b", x: 9, y: 9, width: 100, height: 50 },
      ],
      edges: [{ id: "e1", fromNode: "a", toNode: "b" }],
    });
    if ("error" in canvas) throw new Error(canvas.error);
    layoutCanvas(canvas.canvas, "roadmap", 40);
    const byId = new Map(canvas.canvas.nodes.map((node) => [node.id, node]));
    // Sources first in file order (`c`, then `a`), each dependent after its source.
    expect(byId.get("c")?.x).toBe(0);
    expect(byId.get("a")?.x).toBe(140);
    expect(byId.get("b")?.x).toBe(280);
    expect(byId.get("a")?.y).toBe(0);

    layoutCanvas(canvas.canvas, "hub", 60);
    expect(byId.get("c")?.x).toBe(0);
    expect(byId.get("c")?.y).toBe(0);
  });

  it("converts a Markdown outline both ways", () => {
    const built = canvasFromMarkdown("# Plan\n\n- one\n  - two\n\n## Next\n");
    expect(built.canvas.nodes).toHaveLength(4);
    // Plan → one → two, and Plan → Next (`## Next` is shallower than the list item).
    expect(built.canvas.edges).toHaveLength(3);
    const outline = canvasToMarkdown(built.canvas);
    expect(outline).toContain("- Plan");
    expect(outline).toContain("  - one");
    expect(outline).toContain("    - two");
    expect(outline).toContain("  - Next");
  });
});

describe("canvas tools", () => {
  it("creates, grows, connects, reads and removes a board", async () => {
    const created = workspace();
    const settings = runtimeSettings(created.vault);

    const createdCanvas = await dispatchTool("canvas_create", { path: "Projects/Map" }, settings);
    expect(createdCanvas.isError).toBeUndefined();
    expect(createdCanvas.structuredContent).toMatchObject({ path: "Projects/Map.canvas", nodes: 0, edges: 0 });

    const first = await dispatchTool(
      "canvas_add_node",
      { path: "Projects/Map.canvas", text: "# Start", x: 0, y: 0 },
      settings,
    );
    const firstNode = (first.structuredContent as { node: { id: string; width: number; height: number } }).node;
    expect(firstNode.width).toBe(250);

    const second = await dispatchTool(
      "canvas_add_node",
      { path: "Projects/Map.canvas", text: "Next step", type: "text" },
      settings,
    );
    const secondNode = (second.structuredContent as { node: { id: string; x: number; y: number; width: number } }).node;
    // Automatic placement: beside the first card, never on top of it.
    expect(secondNode.x).toBeGreaterThanOrEqual(firstNode.width);

    const edge = await dispatchTool(
      "canvas_add_edge",
      { path: "Projects/Map.canvas", from: firstNode.id, to: secondNode.id, label: "then" },
      settings,
    );
    expect(edge.isError).toBeUndefined();

    const duplicate = await dispatchTool(
      "canvas_add_edge",
      { path: "Projects/Map.canvas", from: firstNode.id, to: secondNode.id, label: "then" },
      settings,
    );
    expect(duplicate.structuredContent).toMatchObject({ duplicate: true, created: false });

    const read = await dispatchTool("canvas_read", { path: "Projects/Map.canvas" }, settings);
    expect(read.structuredContent).toMatchObject({ node_count: 2, edge_count: 1 });
    expect(read.text).toContain(firstNode.id);

    const updated = await dispatchTool(
      "canvas_update_node",
      { path: "Projects/Map.canvas", id: secondNode.id, text: "Next step (revised)", color: "3" },
      settings,
    );
    expect(updated.structuredContent).toMatchObject({ node: { text: "Next step (revised)", color: "3" } });

    const removed = await dispatchTool(
      "canvas_remove",
      { path: "Projects/Map.canvas", nodes: [firstNode.id] },
      settings,
    );
    expect(removed.structuredContent).toMatchObject({ removed_nodes: [firstNode.id], nodes: 1, edges: 0 });
    expect(readFile(created, "Projects/Map.canvas")).toMatchObject({ edges: [] });
  });

  it("writes only the two JSON Canvas keys, not its own wrapper", async () => {
    const created = workspace();
    const settings = runtimeSettings(created.vault);
    await dispatchTool("canvas_create", { path: "Boards/Clean" }, settings);
    const first = await dispatchTool("canvas_add_node", { path: "Boards/Clean.canvas", text: "a" }, settings);
    const second = await dispatchTool("canvas_add_node", { path: "Boards/Clean.canvas", text: "b" }, settings);
    const a = (first.structuredContent as { node: { id: string } }).node.id;
    const b = (second.structuredContent as { node: { id: string } }).node.id;
    await dispatchTool("canvas_add_edge", { path: "Boards/Clean.canvas", from: a, to: b }, settings);
    await dispatchTool("canvas_update_node", { path: "Boards/Clean.canvas", id: b, text: "b2" }, settings);

    const stored = readFile(created, "Boards/Clean.canvas");
    expect(Object.keys(stored).sort()).toEqual(["edges", "nodes"]);
  });

  it("lists canvases and exports one as Markdown", async () => {
    const created = workspace();
    const settings = runtimeSettings(created.vault);
    await dispatchTool("canvas_create", { path: "Boards/Plan" }, settings);
    const list = await dispatchTool("canvas_list", {}, settings);
    expect(list.text).toContain("Boards/Plan.canvas");

    const fromMarkdown = await dispatchTool(
      "canvas_from_markdown",
      { path: "Boards/Outline", markdown: "# Root\n\n- child\n" },
      settings,
    );
    expect(fromMarkdown.structuredContent).toMatchObject({ nodes: 2, edges: 1 });

    const exported = await dispatchTool("canvas_to_markdown", { path: "Boards/Outline.canvas" }, settings);
    expect(exported.text).toContain("- Root");
    expect(exported.text).toContain("  - child");
  });

  it("refuses to overwrite, to leave the vault, or to write when readOnly is on", async () => {
    const created = workspace();
    const settings = runtimeSettings(created.vault);
    await dispatchTool("canvas_create", { path: "Map" }, settings);

    const again = await dispatchTool("canvas_create", { path: "Map" }, settings);
    expect(again.isError).toBe(true);
    expect(again.text).toContain("already exists");

    const outside = await dispatchTool("canvas_read", { path: "../secrets.canvas" }, settings);
    expect(outside.isError).toBe(true);

    const dotPath = await dispatchTool("canvas_create", { path: ".obsidian/board" }, settings);
    expect(dotPath.isError).toBe(true);

    const readOnly = await dispatchTool(
      "canvas_add_node",
      { path: "Map.canvas", text: "nope" },
      runtimeSettings(created.vault, { readOnly: true }),
    );
    expect(readOnly.isError).toBe(true);
    expect(readOnly.text).toContain("readOnly");
  });

  it("reports a malformed canvas rather than rewriting it", async () => {
    const created = workspace({ "Broken.canvas": "{ \"nodes\": [ " });
    const outcome = await dispatchTool("canvas_read", { path: "Broken.canvas" }, runtimeSettings(created.vault));
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("not valid JSON");
  });

  it("keeps unknown per-node fields when a node is edited", async () => {
    const created = workspace({
      "Boards/Keep.canvas": JSON.stringify({
        nodes: [{ id: "n1", type: "text", text: "before", x: 0, y: 0, width: 200, height: 80, fromFuture: "yes" }],
        edges: [],
      }),
    });
    const settings = runtimeSettings(created.vault);
    const outcome = await dispatchTool("canvas_update_node", { path: "Boards/Keep.canvas", id: "n1", text: "after" }, settings);
    expect(outcome.isError).toBeUndefined();
    const stored = readFile(created, "Boards/Keep.canvas") as { nodes: Array<Record<string, unknown>> };
    expect(stored.nodes[0]).toMatchObject({ text: "after", fromFuture: "yes" });
  });
});
