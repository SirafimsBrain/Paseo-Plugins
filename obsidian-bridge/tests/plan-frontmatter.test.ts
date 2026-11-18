import { describe, expect, it } from "vitest";
import {
  parsePlanDocument,
  positiveInt,
  serializePlanDocument,
  stringField,
  withKey,
} from "../server/plan/frontmatter";
import { livePlanDocuments, PLAN_FIXTURE } from "./plan-fixtures";

function parsed(text: string) {
  const result = parsePlanDocument(text);
  if ("error" in result) throw new Error(result.error);
  return result.document;
}

describe("parsePlanDocument", () => {
  it("parses every fixture document with its counters and body", () => {
    for (const [vaultPath, text] of Object.entries(PLAN_FIXTURE)) {
      const document = parsed(text);
      expect(typeof document.frontmatter.kind, vaultPath).toBe("string");
      expect(positiveInt(document.frontmatter.version ?? 1), vaultPath).not.toBeNull();
      expect(document.body.startsWith("#"), vaultPath).toBe(true);
    }
  });

  it("keeps key order, including keys the schema does not know yet", () => {
    const text = [
      "---",
      "kind: leaf",
      "id: x",
      "future_key: 1",
      "name: N",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    const document = parsed(text);
    expect(Object.keys(document.frontmatter)).toEqual(["kind", "id", "future_key", "name"]);
  });

  it("keeps timestamps and nulls as written", () => {
    const document = parsed(PLAN_FIXTURE["Workspaces/centurion/centurion.md"]);
    expect(document.frontmatter.created).toBe("2026-11-01T09:00:00Z");
    expect(document.frontmatter.parent).toBeNull();
    expect(document.frontmatter.archived).toBeNull();
  });

  it("normalizes CRLF and a byte-order mark", () => {
    const document = parsed(`\uFEFF---\r\nkind: leaf\r\n---\r\n\r\nbody\r\n`);
    expect(document.frontmatter.kind).toBe("leaf");
    expect(document.body).toBe("body");
  });

  it("refuses a file without frontmatter", () => {
    const result = parsePlanDocument("# Just a note\n");
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("does not start with YAML frontmatter");
  });

  it("refuses broken YAML instead of guessing", () => {
    const result = parsePlanDocument("---\nkind: [unclosed\n---\n\nbody\n");
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("not valid YAML");
  });

  it("refuses duplicate keys", () => {
    const result = parsePlanDocument("---\nkind: leaf\nkind: goal\n---\n\nbody\n");
    expect("error" in result).toBe(true);
  });

  it("refuses a sequence as frontmatter", () => {
    const result = parsePlanDocument("---\n- a\n- b\n---\n\nbody\n");
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("must be a YAML mapping");
  });
});

describe("serializePlanDocument", () => {
  it("round-trips every live fixture: same keys, same order, same body", () => {
    for (const [vaultPath, text] of livePlanDocuments()) {
      const first = parsed(text);
      const second = parsed(serializePlanDocument(first));
      expect(Object.keys(second.frontmatter), vaultPath).toEqual(
        Object.keys(first.frontmatter),
      );
      expect(second.frontmatter, vaultPath).toEqual(first.frontmatter);
      expect(second.body, vaultPath).toBe(first.body);
    }
  });

  it("changes one field without losing any other key or the body", () => {
    const original = parsed(PLAN_FIXTURE["Workspaces/centurion/backend/auth/session-store.md"]);
    const changed = withKey(original, "status", "blocked");
    const reread = parsed(serializePlanDocument(changed));

    expect(reread.frontmatter.status).toBe("blocked");
    expect(reread.frontmatter.brief).toEqual(original.frontmatter.brief);
    expect(reread.frontmatter.influences).toEqual(original.frontmatter.influences);
    expect(reread.frontmatter.journal).toEqual(original.frontmatter.journal);
    expect(reread.body).toBe(original.body);
    expect(Object.keys(reread.frontmatter)).toEqual(Object.keys(original.frontmatter));
  });

  it("deletes a key when the value is undefined", () => {
    const original = parsed(PLAN_FIXTURE["Workspaces/centurion/_goals/session-persistence.md"]);
    const changed = withKey(original, "materialized", undefined);
    expect("materialized" in changed.frontmatter).toBe(false);
  });

  it("writes a body exactly once with a trailing newline", () => {
    const text = serializePlanDocument({
      frontmatter: { kind: "leaf" },
      body: "## Заметки\n\nТекст",
    });
    expect(text.startsWith("---\nkind: leaf\n---\n\n## Заметки")).toBe(true);
    expect(text.endsWith("Текст\n")).toBe(true);
  });
});

describe("field helpers", () => {
  it("reads only usable values", () => {
    expect(positiveInt(3)).toBe(3);
    expect(positiveInt(0)).toBeNull();
    expect(positiveInt("3")).toBeNull();
    expect(stringField("  x ")).toBe("x");
    expect(stringField("   ")).toBeNull();
    expect(stringField(5)).toBeNull();
  });
});
