import { describe, expect, it } from "vitest";
import { parsePlanDocument, serializePlanDocument, withKey } from "../server/plan/frontmatter";
import {
  GENERATED_SECTIONS,
  bodyMatchesFrontmatter,
  extractNotes,
  linkedTargets,
  renderPlanBody,
  sectionBody,
} from "../server/plan/sections";
import { PLAN_FIXTURE } from "./plan-fixtures";

function documentOf(vaultPath: string) {
  const result = parsePlanDocument(PLAN_FIXTURE[vaultPath]);
  if ("error" in result) throw new Error(result.error);
  return result.document;
}

const LEAF = "Workspaces/centurion/backend/auth/session-store.md";

describe("renderPlanBody", () => {
  it("renders every generated section from frontmatter", () => {
    const document = documentOf(LEAF);
    const body = renderPlanBody(document.frontmatter, document.body);

    for (const heading of GENERATED_SECTIONS) expect(body).toContain(`## ${heading}`);
    expect(body).toContain(
      '- [[Workspaces/centurion/backend/auth/token-refresh|token-refresh]] — active — A rotation change',
    );
    expect(body).toContain("- [[Workspaces/centurion/_incidents/inc-7-session-loss|INC-7 session loss]]");
    expect(body).toContain("v1 r4 → r5 · actor: codex");
  });

  it("keeps ## Заметки verbatim and puts it before the journal", () => {
    const document = documentOf(LEAF);
    const body = renderPlanBody(document.frontmatter, document.body);
    expect(extractNotes(body)).toBe(
      "Хэш считается до вставки; TTL живёт в settings.py.",
    );
    expect(body.indexOf("## Заметки")).toBeLessThan(body.indexOf("## Журнал"));
  });

  it("writes an em dash for an empty section, so a missing heading is a divergence", () => {
    const body = renderPlanBody({ children: [] }, "");
    for (const heading of GENERATED_SECTIONS) {
      expect(body).toContain(`## ${heading}\n\n—`);
    }
  });

  it("renders children of a branch in frontmatter order", () => {
    const document = documentOf("Workspaces/centurion/backend/auth/auth.md");
    const body = renderPlanBody(document.frontmatter, document.body);
    const children = sectionBody(body, "Дети") ?? "";
    expect(children.split("\n")).toEqual([
      "- [[Workspaces/centurion/backend/auth/session-store|session-store]]",
      "- [[Workspaces/centurion/backend/auth/token-refresh|token-refresh]]",
    ]);
  });

  it("renders nothing that is not in frontmatter", () => {
    const document = documentOf(LEAF);
    const body = renderPlanBody(document.frontmatter, document.body);
    expect(body).not.toContain("payload");
    expect(body).not.toContain("version:");
  });

  it("is stable: rendering twice gives the same text", () => {
    const document = documentOf(LEAF);
    const once = renderPlanBody(document.frontmatter, document.body);
    expect(renderPlanBody(document.frontmatter, once)).toBe(once);
  });

  it("opens with the name and description, so the note reads without Properties", () => {
    const document = documentOf(LEAF);
    const body = renderPlanBody(document.frontmatter, document.body);
    expect(body.startsWith(`# ${String(document.frontmatter.name)}`)).toBe(true);
    expect(body.indexOf("## Влияния")).toBeGreaterThan(0);
    expect(body.slice(0, body.indexOf("## Влияния"))).toContain(
      String(document.frontmatter.description),
    );
  });

  it("lists an incident's blocked leaves in ## Блокировки", () => {
    const body = renderPlanBody({ blocks: ["[[Workspaces/a/b/leaf|leaf]]"], blocked_by: [] }, "");
    expect(sectionBody(body, "Блокировки")).toContain("- [[Workspaces/a/b/leaf|leaf]]");
  });

  it("treats the empty-section placeholder as no notes", () => {
    expect(extractNotes("## Заметки\n\n—")).toBe("");
    expect(extractNotes("## Заметки\n\nReal text.")).toBe("Real text.");
  });
});

describe("bodyMatchesFrontmatter", () => {
  it("accepts a body the renderer produced", () => {
    const document = documentOf(LEAF);
    const body = renderPlanBody(document.frontmatter, document.body);
    expect(bodyMatchesFrontmatter({ frontmatter: document.frontmatter, body })).toBe(true);
  });

  it("reports a hand edit of a generated section", () => {
    const document = documentOf(LEAF);
    const body = renderPlanBody(document.frontmatter, document.body).replace(
      "— active —",
      "— resolved —",
    );
    expect(bodyMatchesFrontmatter({ frontmatter: document.frontmatter, body })).toBe(false);
  });

  it("accepts a file written before the opening existed", () => {
    const document = documentOf(LEAF);
    const rendered = renderPlanBody(document.frontmatter, document.body);
    const legacy = rendered.slice(rendered.indexOf("## Влияния"));
    expect(bodyMatchesFrontmatter({ frontmatter: document.frontmatter, body: legacy })).toBe(true);
  });

  it("ignores trailing whitespace and blank-line differences", () => {
    const document = documentOf(LEAF);
    const body = `${renderPlanBody(document.frontmatter, document.body)}\n\n   \n`;
    expect(bodyMatchesFrontmatter({ frontmatter: document.frontmatter, body })).toBe(true);
  });

  it("does not count a hand-edited ## Заметки as divergence", () => {
    const document = documentOf(LEAF);
    const rendered = renderPlanBody(document.frontmatter, document.body);
    const body = rendered.replace("TTL живёт в settings.py.", "TTL живёт в settings.py и .env.");
    expect(bodyMatchesFrontmatter({ frontmatter: document.frontmatter, body })).toBe(true);
  });
});

describe("serialize + render", () => {
  it("keeps the journal readable in a written file", () => {
    const document = documentOf(LEAF);
    const body = renderPlanBody(document.frontmatter, document.body);
    const text = serializePlanDocument({ frontmatter: document.frontmatter, body });
    const reread = parsePlanDocument(text);
    if ("error" in reread) throw new Error(reread.error);
    expect(reread.document.body).toContain("- 2026-11-18T10:40:00Z · plan_update_node");
    expect(bodyMatchesFrontmatter(reread.document)).toBe(true);
  });

  it("reflects a status change in the rendered file", () => {
    const document = documentOf(LEAF);
    const changed = withKey(document, "status", "blocked");
    const body = renderPlanBody(changed.frontmatter, document.body);
    const text = serializePlanDocument({ frontmatter: changed.frontmatter, body });
    expect(text).toContain("status: blocked");
  });
});

describe("linkedTargets", () => {
  it("collects the label of every relation link", () => {
    const document = documentOf(LEAF);
    expect(linkedTargets(document.frontmatter)).toEqual(
      expect.arrayContaining(["token-refresh", "INC-7 session loss", "auth"]),
    );
  });

  it("returns unique labels", () => {
    expect(linkedTargets({ children: ["[[a|same]]", "[[b|same]]"] })).toEqual(["same"]);
  });
});
