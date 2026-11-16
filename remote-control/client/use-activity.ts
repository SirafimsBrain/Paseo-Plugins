import { useState } from "react";
import { useSubscription } from "@getpaseo/plugin/client";
import { activityStream, type ActivitySnapshot } from "../shared/activity";

/**
 * The live activity snapshot (stage 1.1.0, Paseo 0.16.0 subscriptions).
 *
 * `null` until the first push arrives (the daemon sends one immediately on
 * subscribe). Every surface that used to poll `state` reads this instead, so
 * a lock, a window launch or a terminal exit shows up everywhere at once.
 *
 * The subscription is per surface: Paseo re-subscribes after a reconnect and
 * releases it when the panel or screen unmounts.
 */
export function useRemoteActivity(): ActivitySnapshot | null {
  const [snapshot, setSnapshot] = useState<ActivitySnapshot | null>(null);
  useSubscription(activityStream, {}, (event) => setSnapshot(event));
  return snapshot;
}
