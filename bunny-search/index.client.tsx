import type { PluginClientContext } from "@getpaseo/plugin/client";
import { agentReload, runSearch } from "./shared/contracts";
import { BunnySearchAgentPanel } from "./client/agent-panel";
import { BunnySearchComposerItem } from "./client/composer-item";
import { SCREEN_ID } from "./client/screen-id";
import { BunnySearchSettingsScreen } from "./client/settings-screen";
import { BunnySearchSidebarItem } from "./client/sidebar-item";
import { BunnySearchSurface } from "./client/surface";

/** Longest slash-command argument sent as a query; providers truncate far below this. */
const MAX_SLASH_QUERY_LENGTH = 512;

export default function contribute(client: PluginClientContext) {
  // Sidebar header row: connection status dot + navigation to the screen (0.8.7).
  client.addSidebarHeaderItem({
    id: SCREEN_ID,
    title: "Bunny Search",
    Component: BunnySearchSidebarItem,
  });

  // Sidebar screen: connection status indicator + quick search.
  client.addScreen({
    id: SCREEN_ID,
    title: "Bunny Search",
    Component: BunnySearchSurface,
  });

  client.addCommandCenterItem({
    id: "open-bunny-search",
    title: "Bunny Search settings (web search MCP)",
    icon: "Globe",
    keywords: ["bunny", "search", "duckduckjs", "searxng", "web", "mcp", "internet"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: SCREEN_ID });
    },
  });

  // Composer control (0.7.5, Paseo 0.16.0 `addComposerItem`): search the draft and
  // insert the results without leaving the composer.
  client.addComposerItem({
    id: "bunny-search-draft",
    Component: BunnySearchComposerItem,
  });

  // Slash command (0.8.7): `/bunny-search <query>` runs the configured service and
  // inserts the formatted answer into this agent's composer — the keyboard-only route
  // for users who never open the screen. A rejected search throws, which the host shows
  // as an error instead of silently inserting nothing.
  client.addSlashCommand({
    name: "bunny-search",
    description: "Search the web and insert the results into the prompt",
    argumentHint: "<query>",
    context: "agent",
    async onSubmit({ args, rpc, composers, agent }) {
      const query = args.trim().slice(0, MAX_SLASH_QUERY_LENGTH);
      if (query.length === 0) {
        throw new Error("Usage: /bunny-search <query>");
      }
      const result = await rpc(runSearch, { query });
      if (!result.ok || !result.text) {
        throw new Error(result.error ?? "Search failed (see plugin logs).");
      }
      const composer = composers({ agentId: agent.id })[0];
      if (!composer) {
        throw new Error("This agent has no open composer to insert into.");
      }
      composer.insertText(`\nWeb search results:\n\n${result.text}\n`);
    },
  });

  // Agent panel (0.8.7): the same search box, scoped to one agent and inserting into
  // that agent's composer, for users who keep the panel open while writing a prompt.
  client.addAgentPanel({
    id: "bunny-search-agent",
    title: "Bunny Search",
    icon: "Globe",
    Component: BunnySearchAgentPanel,
  });

  client.addSettingsScreen({
    id: "bunny-search-settings",
    title: "Bunny Search",
    icon: "Globe",
    Component: BunnySearchSettingsScreen,
  });

  // Repair action (0.5.2): reopen the selected agent's provider session, which
  // reruns `addHook("agent.open.before")` and re-contributes the MCP server or the
  // attached `bunny_web_search` tool. The one-click answer to an agent that lost its
  // search tools after an idle runtime release or an OpenCode location eviction —
  // instead of asking the user to recreate the agent. A throw is surfaced by the
  // host as an error toast, so a refused reload is never silent.
  // Quick search for one agent (0.7.5): opens the screen with the agent's title as
  // the query and runs nothing until the user presses Search — a deep link that is
  // a starting point, not an unasked network request.
  client.addCommandCenterItem({
    id: "search-for-agent",
    title: "Search the web for this agent's task",
    icon: "Search",
    keywords: ["bunny", "search", "web", "quick", "draft", "agent"],
    context: "agent",
    onSelect({ agent, openScreen }) {
      openScreen({ screenId: SCREEN_ID, params: { q: agent.title ?? "" } });
    },
  });

  client.addCommandCenterItem({
    id: "repair-search-tools",
    title: "Repair search tools (reopen this agent's session)",
    icon: "Wrench",
    keywords: ["bunny", "search", "web", "mcp", "tools", "missing", "repair", "reload", "reopen"],
    context: "agent",
    async onSelect({ agent, rpc }) {
      const result = await rpc(agentReload, { agentId: agent.id });
      if (!result.ok) {
        throw new Error(result.error ?? "Could not reopen the agent session.");
      }
    },
  });

  return () => {};
}
