/** The session /global-rules:claude-md was last loaded in, so its guidance is in the conversation. */
export type LoadedIn = string | null

declare module 'claude-code' {
  interface PluginState {
    'global-rules': {
      loadedIn: LoadedIn
    }
  }
}
