import type { AgentSession } from "./session-manager";

/**
 * The sessions a Paseo agent references (0.7.0).
 *
 * The listing already labels a session with the Paseo agent that points at it
 * (`paseoAgent`), so "this agent's transcripts" is a filter over that data — no
 * new RPC and no assumption about where a provider keeps its store. A session can
 * only be listed once per provider, and the server keeps the first link it finds,
 * which is why an empty result is a real "no transcript recorded", not an error.
 */
export function sessionsForAgent(sessions: AgentSession[], agentId: string): AgentSession[] {
  const wanted = agentId.trim();
  if (!wanted) return [];
  return sessions.filter((session) => session.paseoAgent?.id === wanted);
}
