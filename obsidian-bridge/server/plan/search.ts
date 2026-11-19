import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeSettings } from "../../shared/settings";
import type { ToolOutcome } from "../mcp-tools";
import { resolveRoleDirs } from "../dirs";
import { indexPathFor } from "../paths";
import { searchIndex } from "../search";
import { BridgeStore } from "../store";
import { isPlanSystemPath } from "../vault";
import { parsePlanDocument, stringField } from "./frontmatter";
import { isPlanKind } from "./model";
import { resolvePlanRoot } from "./paths";
import { isSnapshotFrontmatter } from "./snapshot";

/**
 * `plan_search`: the existing index, narrowed to the plan.
 *
 * It is deliberately a thin wrapper rather than a second search engine: the
 * vault index already ranks notes by title, aliases, tags, links and body, and
 * a plan is just notes. What planning adds is the boundary and the filters:
 *
 * - only paths under `planRoot` are considered, even if the index contains
 *   more (a stale row, a folder argument, a future index change);
 * - `kind`, `status` and `project` are read from **frontmatter**, not matched in
 *   text — searching "done" must not return a node merely because its
 *   description says "done";
 * - `__history` and `_archive` never appear (they are not indexed, and the
 *   prefix/skip checks refuse them again here);
 * - a note without plan frontmatter is skipped and counted, not returned as a
 *   plan node.
 */

/** Words of a query that must appear in a hit; short tokens are punctuation noise. */
function queryTokens(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2))];
}

function asList(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
  }
  return [];
}

export function planSearch(
  settings: RuntimeSettings,
  input: Record<string, unknown>,
): ToolOutcome {
  const resolved = resolvePlanRoot(settings);
  if ("reason" in resolved) {
    return {
      text: resolved.error,
      isError: true,
      structuredContent: { planning_available: false, reason: resolved.reason },
    };
  }
  const root = resolved.root;

  const query = typeof input.query === "string" ? input.query.trim() : "";
  const limit =
    typeof input.limit === "number" && Number.isFinite(input.limit)
      ? Math.max(1, Math.min(50, Math.trunc(input.limit)))
      : settings.maxResults;
  const kinds = asList(input.kind).map((value) => value.toLowerCase());
  const statuses = asList(input.status).map((value) => value.toLowerCase());
  const project = typeof input.project === "string" ? input.project.trim() : "";

  let store: BridgeStore | null = null;
  try {
    store = new BridgeStore(indexPathFor(root.vaultRoot), { stemming: settings.ftsStemming });
    if (store.counts().notes === 0) {
      return {
        text: JSON.stringify(
          {
            planning_available: true,
            root: root.relPath,
            query,
            hits: [],
            total: 0,
            note:
              "The vault index is empty, so planning search has nothing to rank. " +
              "Run `obsidian_index` (or wait for the next scan) and search again.",
          },
          null,
          2,
        ),
        structuredContent: {
          planning_available: true,
          root: root.relPath,
          query,
          hits: [],
          total: 0,
        },
      };
    }

    const result = searchIndex(store, {
      query,
      // Ask for more than the caller wants: filters and de-duplication happen
      // after ranking, and a plan node can be hit through several headings.
      limit: 50,
      folder: root.relPath,
      dirs: resolveRoleDirs(settings),
      snippetChars: settings.snippetChars,
      budgetChars: settings.searchBudgetChars,
    });

    const prefix = `${root.relPath}/`;
    const tokens = queryTokens(query);
    const hits: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    let filtered = 0;
    let skipped = 0;
    // The fusion includes one-hop link neighbours and recency, which are useful
    // for browsing but not evidence that a plan node answers the query. A hit
    // that contains none of the query words is dropped, so a plan search does
    // not return eight unrelated nodes just because they sit next to a match.
    let unmatched = 0;

    for (const hit of result.hits) {
      const vaultPath = hit.path.replace(/\\/g, "/");
      if (!vaultPath.startsWith(prefix) || isPlanSystemPath(vaultPath)) continue;
      if (seen.has(vaultPath)) continue;

      let text: string;
      try {
        const absolute = path.join(root.vaultRoot, vaultPath);
        if (fs.statSync(absolute).size > 4 * 1024 * 1024) {
          skipped += 1;
          continue;
        }
        text = fs.readFileSync(absolute, "utf-8");
      } catch {
        skipped += 1;
        continue;
      }
      if (tokens.length > 0) {
        const haystack = text.toLowerCase();
        if (!tokens.some((token) => haystack.includes(token))) {
          unmatched += 1;
          continue;
        }
      }
      const parsed = parsePlanDocument(text);
      if ("error" in parsed) {
        skipped += 1;
        continue;
      }
      const frontmatter = parsed.document.frontmatter;
      if (isSnapshotFrontmatter(frontmatter) || !isPlanKind(frontmatter.kind)) {
        skipped += 1;
        continue;
      }

      const relPath = vaultPath.slice(prefix.length);
      const hitProject = relPath.includes("/") && !relPath.startsWith("_")
        ? relPath.split("/")[0]
        : null;
      const kind = frontmatter.kind;
      const status = stringField(frontmatter.status);

      if (kinds.length > 0 && !kinds.includes(kind)) {
        filtered += 1;
        continue;
      }
      if (statuses.length > 0 && (status === null || !statuses.includes(status.toLowerCase()))) {
        filtered += 1;
        continue;
      }
      if (project.length > 0 && hitProject !== project) {
        filtered += 1;
        continue;
      }

      seen.add(vaultPath);
      hits.push({
        path: relPath,
        vault_path: vaultPath,
        kind,
        status,
        name: stringField(frontmatter.name) ?? relPath.replace(/\.md$/i, ""),
        project: hitProject,
        version: frontmatter.version ?? null,
        revision: frontmatter.revision ?? null,
        heading: hit.heading,
        snippet: hit.snippet,
        score: Math.round(hit.score * 1000) / 1000,
      });
      if (hits.length >= limit) break;
    }

    const payload = {
      planning_available: true,
      root: root.relPath,
      query,
      filters: {
        kind: kinds,
        status: statuses,
        project: project.length > 0 ? project : null,
      },
      total: hits.length,
      filtered,
      skipped,
      unmatched,
      hits,
      note:
        hits.length === 0
          ? "Ranking comes from the plugin index: a file changed on disk appears after the next scan."
          : null,
    };
    return { text: JSON.stringify(payload, null, 2), structuredContent: payload };
  } catch (cause) {
    return {
      text: `Planning search failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      isError: true,
    };
  } finally {
    try {
      store?.close();
    } catch {
      // A failed close must not hide the answer.
    }
  }
}
