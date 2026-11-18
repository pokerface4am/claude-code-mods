/** The arming of this session: how many pings may run per idle stretch, and how many ran since the last real turn. */
export type KeepalivePlan = { max: number; used: number }

declare module 'claude-code' {
  interface PluginState {
    'cache-keepalive': {
      /** null: keep-alive is off. */
      plan: KeepalivePlan | null
      /** When the main thread's prompt cache was last touched (ms since epoch); null: unknown, nothing to keep alive yet. */
      lastApiAt: number | null
      /** The text the latest /keepalive run printed: its output row is drawn in full, every older one collapsed. */
      latestText: string | null
    }
  }
}
