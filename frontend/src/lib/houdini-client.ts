import { HoudiniClient, subscription } from "$houdini";
import { createClient as createWSClient } from "graphql-ws";

const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${wsProtocol}//${location.host}/graphql`;

/**
 * Bumps every time the GraphQL WebSocket completes a (re)connect. Pages
 * watching live data should subscribe to this and refetch their list query
 * — the subscription itself only fires on NEW state changes, so any update
 * that arrived during disconnect would be silently lost otherwise.
 */
const wsConnectListeners = new Set<(generation: number) => void>();
let connectionGeneration = 0;

export function onWsConnected(cb: (generation: number) => void): () => void {
  wsConnectListeners.add(cb);
  return () => wsConnectListeners.delete(cb);
}

export default new HoudiniClient({
  url: "/graphql",
  plugins: [
    subscription(() =>
      createWSClient({
        url: wsUrl,
        retryAttempts: Infinity,
        shouldRetry: () => true,
        on: {
          connected: () => {
            connectionGeneration += 1;
            for (const cb of wsConnectListeners) cb(connectionGeneration);
          },
        },
      }),
    ),
  ],
});
