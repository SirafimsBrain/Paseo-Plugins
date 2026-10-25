import type { PluginClientContext } from "@getpaseo/plugin/client";

export default function contribute(_client: PluginClientContext): () => void {
  // Remote Control native surface is added in later stages.
  return () => {};
}