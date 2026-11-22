import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { RemoteControlPanel } from "./console-panel";

/**
 * Remote Control beside an agent (stage 1.1.2, Paseo 0.17.1 recommendation 2,
 * `addAgentPanel`).
 *
 * The panel is the same one the Explorer location shows — connections, the
 * vault form, launch buttons, the console — because what it operates on is the
 * workspace, not the agent. A remote session is opened from a workspace and
 * stays there, so the panel carries a line saying so instead of implying that
 * its sessions belong to this agent alone. `agentId` is deliberately not read:
 * nothing here is per-agent, and 0.17.1 deprecates the `agentId`/`context`
 * props in favour of `params.agentId`, which this panel therefore never needs.
 */
export function RemoteControlAgentPanel(props: PluginAgentPanelProps) {
  return (
    <RemoteControlPanel
      theme={props.theme}
      workspaceId={props.workspaceId}
      navigation={props.navigation}
      tab={props.tab}
      scope="agent"
    />
  );
}
