import { describe, expect, it } from "vitest";
import {
  chunkNote,
  extractLinks,
  extractTags,
  parseNote,
  parseYamlSubset,
  splitFrontmatter,
} from "../server/parse";

describe("frontmatter", () => {
  it("parses scalars, inline lists and block lists", () => {
    const data = parseYamlSubset(
      ["title: Queue design", "tags: [queue, research]", "aliases:", "  - QD", "  - QueueDoc", "status: active"].join(
        "\n",
      ),
    );
    expect(data.title).toBe("Queue design");
    expect(data.tags).toEqual(["queue", "research"]);
    expect(data.aliases).toEqual(["QD", "QueueDoc"]);
    expect(data.status).toBe("active");
  });

  it("splits the frontmatter from the body", () => {
    const { raw, data, body } = splitFrontmatter("---\ntitle: X\n---\n\n# Heading\nbody\n");
    expect(raw.trim()).toBe("title: X");
    expect(data.title).toBe("X");
    expect(body.startsWith("# Heading")).toBe(true);
  });

  it("returns the whole document when there is no frontmatter", () => {
    const { raw, body } = splitFrontmatter("# Just a note\n");
    expect(raw).toBe("");
    expect(body).toBe("# Just a note\n");
  });
});

describe("tags and links", () => {
  it("collects frontmatter and inline tags, ignoring code fences", () => {
    const tags = extractTags(
      ["# Alpha", "text #beta/nested and #2024", "```", "#notATag", "```", "<!-- #commented -->"].join("\n"),
      { tags: ["front"] },
    );
    expect(tags).toContain("front");
    expect(tags).toContain("beta/nested");
    expect(tags).not.toContain("notATag");
  });

  it("extracts wikilinks, aliases, anchors and embeds", () => {
    const links = extractLinks(
      "See [[Plan]] and [[Projects/x/Roadmap|roadmap]] and [[Plan#Milestones]] and ![[diagram.png]].",
    );
    expect(links).toHaveLength(4);
    expect(links[0]).toMatchObject({ rawTarget: "Plan", kind: "link" });
    expect(links[1]).toMatchObject({ rawTarget: "Projects/x/Roadmap", alias: "roadmap" });
    expect(links[2]).toMatchObject({ rawTarget: "Plan", anchor: "Milestones" });
    expect(links[3]).toMatchObject({ rawTarget: "diagram.png", kind: "embed" });
  });
});

describe("chunking", () => {
  it("keeps the heading path for nested sections", () => {
    const chunks = chunkNote("# Top\nintro\n## Child\ntext\n### Grandchild\ndeep\n");
    expect(chunks.map((chunk) => chunk.heading)).toEqual(["Top", "Top › Child", "Top › Child › Grandchild"]);
    expect(chunks[2].text).toContain("deep");
  });

  it("splits oversized sections on blank lines", () => {
    const paragraph = "a".repeat(900);
    const chunks = chunkNote(`# Big\n\n${paragraph}\n\n${paragraph}\n`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length <= 1200)).toBe(true);
  });

  it("parses a full note into title, tags, links and chunks", () => {
    const note = parseNote(
      "---\ntitle: Queue design\ntags: [queue]\n---\n\n# Queue design\n\nBody text [[Other]].\n\n## Details\nMore.\n",
      "Projects/orion/Research/queue.md",
    );
    expect(note.title).toBe("Queue design");
    expect(note.tags).toContain("queue");
    expect(note.links[0].rawTarget).toBe("Other");
    expect(note.headings).toHaveLength(2);
    expect(note.chunks.length).toBeGreaterThanOrEqual(2);
    expect(note.wordCount).toBeGreaterThan(0);
  });
});
