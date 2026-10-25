import type { PluginServerContext } from "@getpaseo/plugin/server";

export default function contribute(_server: PluginServerContext): () => void {
  // Remote Control server surface is added in later stages.
  return () => {};
}