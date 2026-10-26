/**
 * The plain board (PLAN.md stage K1, ADR-10): the card view of the dashboard
 * and its **default** — the toolbar's Plain button comes before 2D/3D.
 *
 * The board is a kanban turned 90° left: horizontal zones stacked top to
 * bottom (PLAN → ACTIVE → DONE), each breaking down into (entity, status)
 * groups, each leaf group hanging its cards under collapsible tree sections
 * — the "expand the structure to the required depth" requirement. The
 * component only *renders* what the pure adapter (`dashboard/src/plain.ts`)
 * decided: zones, groups, sections, cards and every count come ready-made,
 * and the collapse state is a `Set` of section keys the app owns.
 *
 * Interaction (K1 + K2): **every** card is a button that opens the detail
 * modal — a leaf card also selects its node (the same `selectedId` the 2D/3D
 * views use; the detail fetch it triggers is what the modal renders), goal
 * and bug cards open their own payload-backed content. Search scrolls its
 * hit into view through `scrollTargetEntityId`. Status is always colour
 * **plus** text, the project-wide accessibility rule.
 */
import { useEffect } from "react";
import type { ReactElement } from "react";
import type { LeafStatus, NodeKind } from "../../../shared/tree";
import type { BugStatus } from "../../../shared/links";
import type { GoalStatus } from "../../../shared/goals";
import {
  BUG_BADGE_COLOR,
  BUG_STATUS_COLORS,
  BUG_STATUS_LABELS,
  GOAL_STATUS_COLORS,
  GOAL_STATUS_LABELS,
  KIND_COLORS,
  KIND_GLYPHS,
  STATUS_COLORS,
  STATUS_LABELS,
} from "../colors";
import {
  PLAIN_ZONE_EMPTY_HINTS,
  PLAIN_ZONE_GLYPHS,
  PLAIN_ZONE_LABELS,
  type PlainBoard,
  type PlainBugCard,
  type PlainCard,
  type PlainCardKind,
  type PlainGoalCard,
  type PlainGroup,
  type PlainLeafCard,
  type PlainSection,
  type PlainZone,
} from "../plain";

/** Props of the board view. */
export interface PlainViewProps {
  /** The board from `buildPlainBoard` (the app rebuilds it on refetch). */
  readonly board: PlainBoard;
  /** Whether `/api/tree` has landed at least once. */
  readonly loaded: boolean;
  /** Section keys currently hiding their subtree. */
  readonly collapsed: ReadonlySet<string>;
  /** Toggles one section (the app owns the set). */
  readonly onToggleSection: (key: string) => void;
  /** The selected node id — its card wears the selection highlight. */
  readonly selectedEntityId: string | null;
  /** A card was clicked (every kind opens the K2 modal; leaves also select). */
  readonly onSelectCard: (kind: PlainCardKind, entityId: string) => void;
  /** Entity id to scroll into view (the toolbar search, G4 semantics). */
  readonly scrollTargetEntityId: string | null;
  /** Title of the empty state (filters that hide everything, etc.). */
  readonly emptyTitle?: string;
  readonly emptyText?: string;
}

/** Cards hidden below a section header (its subtree's cards minus its own). */
function descendantCardCount(section: PlainSection): number {
  let count = 0;
  for (const child of section.children) {
    count += child.cards.length + descendantCardCount(child);
  }
  return count;
}

/** Status accent of a card by its entity kind (one palette, three enums). */
function cardStatusColor(kind: PlainCardKind, status: string): string {
  if (kind === "leaf") return STATUS_COLORS[status as LeafStatus];
  if (kind === "goal") return GOAL_STATUS_COLORS[status as GoalStatus];
  return BUG_STATUS_COLORS[status as BugStatus];
}

/** Status text of a card by its entity kind. */
function cardStatusLabel(kind: PlainCardKind, status: string): string {
  if (kind === "leaf") return STATUS_LABELS[status as LeafStatus];
  if (kind === "goal") return GOAL_STATUS_LABELS[status as GoalStatus];
  return BUG_STATUS_LABELS[status as BugStatus];
}

/** The glyph in front of a card's title, per entity kind. */
function cardGlyph(kind: PlainCardKind): string {
  if (kind === "goal") return "🎯";
  if (kind === "bug") return "🐞";
  return "🍃";
}

/** One horizontal zone band. */
function ZoneBand(props: {
  zone: PlainZone;
  collapsed: ReadonlySet<string>;
  onToggleSection: (key: string) => void;
  selectedEntityId: string | null;
  onSelectCard: (kind: PlainCardKind, entityId: string) => void;
}): ReactElement {
  const { zone } = props;
  return (
    <section className="lp-plain-zone" data-zone={zone.id}>
      <header className="lp-plain-zone-header">
        <span className="lp-plain-zone-glyph" aria-hidden="true">
          {PLAIN_ZONE_GLYPHS[zone.id]}
        </span>
        <h2 className="lp-plain-zone-title">{PLAIN_ZONE_LABELS[zone.id]}</h2>
        <span className="lp-plain-zone-count">
          {zone.cardCount} {zone.cardCount === 1 ? "card" : "cards"}
        </span>
      </header>
      {zone.groups.length === 0 ? (
        <p className="lp-plain-zone-empty">{PLAIN_ZONE_EMPTY_HINTS[zone.id]}</p>
      ) : (
        zone.groups.map((group) => (
          <Group
            key={group.id}
            group={group}
            collapsed={props.collapsed}
            onToggleSection={props.onToggleSection}
            selectedEntityId={props.selectedEntityId}
            onSelectCard={props.onSelectCard}
          />
        ))
      )}
    </section>
  );
}

/** One (entity, status) group inside a zone. */
function Group(props: {
  group: PlainGroup;
  collapsed: ReadonlySet<string>;
  onToggleSection: (key: string) => void;
  selectedEntityId: string | null;
  onSelectCard: (kind: PlainCardKind, entityId: string) => void;
}): ReactElement {
  const { group } = props;
  return (
    <div className="lp-plain-group" data-group={group.id}>
      <h3 className="lp-plain-group-title">
        <span aria-hidden="true">{cardGlyph(group.cardKind)}</span>
        {cardStatusLabel(group.cardKind, group.status)}
        <span
          className="lp-plain-group-dot"
          style={{ backgroundColor: cardStatusColor(group.cardKind, group.status) }}
          aria-hidden="true"
        />
        <span className="lp-plain-group-count">{group.cardCount}</span>
      </h3>
      {group.cards.map((card) => (
        <Card
          key={card.id}
          card={card}
          selected={card.entityId === props.selectedEntityId}
          onSelectCard={props.onSelectCard}
        />
      ))}
      {group.sections.map((section) => (
        <SectionNode
          key={section.key}
          section={section}
          collapsed={props.collapsed}
          onToggleSection={props.onToggleSection}
          selectedEntityId={props.selectedEntityId}
          onSelectCard={props.onSelectCard}
        />
      ))}
    </div>
  );
}

/** A collapsible tree section — nested by tree ancestry (the K1 depth). */
function SectionNode(props: {
  section: PlainSection;
  collapsed: ReadonlySet<string>;
  onToggleSection: (key: string) => void;
  selectedEntityId: string | null;
  onSelectCard: (kind: PlainCardKind, entityId: string) => void;
}): ReactElement {
  const { section } = props;
  const isCollapsed = props.collapsed.has(section.key);
  const hidden = descendantCardCount(section);
  return (
    <div
      className="lp-plain-section"
      style={{ marginInlineStart: `${section.depth * 14}px` }}
    >
      <button
        type="button"
        className="lp-plain-section-toggle"
        aria-expanded={!isCollapsed}
        onClick={() => props.onToggleSection(section.key)}
      >
        <span className="lp-plain-chevron" aria-hidden="true">
          {isCollapsed ? "▸" : "▾"}
        </span>
        <span aria-hidden="true">{KIND_GLYPHS[section.nodeKind as NodeKind]}</span>
        <span className="lp-plain-section-name">{section.name}</span>
        <span className="lp-plain-section-count">
          {section.cards.length}
          {hidden > 0 && isCollapsed ? ` +${hidden}` : ""}
        </span>
      </button>
      {isCollapsed ? null : (
        <>
          {section.cards.map((card) => (
            <Card
              key={card.id}
              card={card}
              selected={card.entityId === props.selectedEntityId}
              onSelectCard={props.onSelectCard}
            />
          ))}
          {section.children.map((child) => (
            <SectionNode
              key={child.key}
              section={child}
              collapsed={props.collapsed}
              onToggleSection={props.onToggleSection}
              selectedEntityId={props.selectedEntityId}
              onSelectCard={props.onSelectCard}
            />
          ))}
        </>
      )}
    </div>
  );
}

/** One card — a button for every kind: the click opens the K2 modal. */
function Card(props: {
  card: PlainCard;
  selected: boolean;
  onSelectCard: (kind: PlainCardKind, entityId: string) => void;
}): ReactElement {
  const { card } = props;
  const className = props.selected
    ? "lp-plain-card lp-plain-card-selected"
    : "lp-plain-card";
  const body = (
    <>
      <div className="lp-plain-card-head">
        <span className="lp-plain-card-title">
          <span aria-hidden="true">{cardGlyph(card.kind)} </span>
          {card.name}
        </span>
        <span className="lp-plain-card-status">
          <span
            className="lp-plain-card-dot"
            style={{ backgroundColor: cardStatusColor(card.kind, card.status) }}
            aria-hidden="true"
          />
          {cardStatusLabel(card.kind, card.status)}
        </span>
      </div>
      {card.kind === "leaf" ? (
        <LeafCardBody card={card} />
      ) : card.kind === "goal" ? (
        <GoalCardBody card={card} />
      ) : (
        <BugCardBody card={card} />
      )}
    </>
  );

  return (
    <button
      type="button"
      id={`lp-plain-card-${card.entityId}`}
      className={className}
      data-kind={card.kind}
      aria-pressed={card.kind === "leaf" ? props.selected : undefined}
      onClick={() => props.onSelectCard(card.kind, card.entityId)}
    >
      {body}
    </button>
  );
}

/** The extra facts a leaf card shows: path, version, growth, badges. */
function LeafCardBody(props: { card: PlainLeafCard }): ReactElement {
  const { card } = props;
  const progress =
    card.growth === null || card.growth.total === 0
      ? null
      : Math.round(card.growth.ratio * 100);
  return (
    <>
      {card.path.length > 0 ? (
        <div className="lp-plain-card-path" title={card.path}>
          {card.path}
        </div>
      ) : null}
      <div className="lp-plain-card-meta">
        <span className="lp-plain-card-mono">
          v{card.version || "—"} · r{card.revision}
        </span>
        {progress !== null ? (
          <span
            className="lp-plain-card-growth"
            title={`${card.growth!.completed}/${card.growth!.total} growth steps${
              card.growth!.failed > 0 ? ` · ${card.growth!.failed} failed` : ""
            }`}
          >
            <span
              className="lp-plain-card-growth-fill"
              style={{ width: `${progress}%` }}
              aria-hidden="true"
            />
            <span className="lp-plain-card-growth-text">
              {card.growth!.completed}/{card.growth!.total} steps
            </span>
          </span>
        ) : null}
        {card.openBugCount > 0 ? (
          <span
            className="lp-plain-card-bugs"
            style={{ color: BUG_BADGE_COLOR }}
            title={`${card.openBugCount} open incident(s) on this leaf`}
          >
            🐞×{card.openBugCount}
          </span>
        ) : null}
        {card.beeCount > 0 ? (
          <span
            className="lp-plain-card-bees"
            title={`${card.beeCount} influence link(s)`}
          >
            🐝×{card.beeCount}
          </span>
        ) : null}
      </div>
    </>
  );
}

/** The extra facts a goal card shows: plan size and materialization. */
function GoalCardBody(props: { card: PlainGoalCard }): ReactElement {
  const { card } = props;
  return (
    <div className="lp-plain-card-meta">
      <span className="lp-plain-card-mono">r{card.revision}</span>
      <span title="Atomic steps in the agent's plan">
        plan: {card.planSteps} {card.planSteps === 1 ? "step" : "steps"}
      </span>
      <span
        className="lp-plain-card-hint"
        title={
          card.materializedNodeId === null
            ? "Not materialized in the tree yet (ADR-7: only approved plans grow a subtree)"
            : "Materialized in the tree"
        }
      >
        {card.materializedNodeId === null ? "not in tree yet" : "in tree"}
      </span>
    </div>
  );
}

/** The extra facts an incident card shows: severity and affected leaves. */
function BugCardBody(props: { card: PlainBugCard }): ReactElement {
  const { card } = props;
  return (
    <div className="lp-plain-card-meta">
      <span className="lp-plain-card-severity" data-severity={card.severity}>
        {card.severity}
      </span>
      <span className="lp-plain-card-mono">r{card.revision}</span>
      <span className="lp-plain-card-hint">
        on {card.attachmentCount} {card.attachmentCount === 1 ? "leaf" : "leaves"}
      </span>
    </div>
  );
}

export function PlainView(props: PlainViewProps): ReactElement {
  const { board, loaded } = props;
  const total = board.index.size;

  // The toolbar search scrolls its hit into view (G4 semantics: the found
  // node must actually be on screen — the app opened its sections first).
  useEffect(() => {
    if (props.scrollTargetEntityId === null) return;
    document
      .getElementById(`lp-plain-card-${props.scrollTargetEntityId}`)
      ?.scrollIntoView({ block: "center" });
  }, [props.scrollTargetEntityId]);

  if (!loaded) {
    return (
      <section className="lp-plain" aria-label="Plain board">
        <p className="lp-plain-hint">Loading the tree…</p>
      </section>
    );
  }

  if (total === 0) {
    return (
      <section className="lp-plain" aria-label="Plain board">
        <div className="lp-plain-empty">
          <p className="lp-plain-empty-title">
            {props.emptyTitle ?? "Nothing on the board yet"}
          </p>
          {props.emptyText !== undefined ? (
            <p className="lp-plain-empty-text">{props.emptyText}</p>
          ) : (
            <p className="lp-plain-empty-text">
              Agents write the tree with the luck_tree_* MCP tools; goals
              proposed from the native panel land in the Plan zone at the top.
            </p>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="lp-plain" aria-label="Plain board">
      {board.zones.map((zone) => (
        <ZoneBand
          key={zone.id}
          zone={zone}
          collapsed={props.collapsed}
          onToggleSection={props.onToggleSection}
          selectedEntityId={props.selectedEntityId}
          onSelectCard={props.onSelectCard}
        />
      ))}
    </section>
  );
}
