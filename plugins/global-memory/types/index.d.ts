/**
 * What the /global-memory menu shows: the list, with what the last delete
 * said; one memory, by name; or the question before it is deleted.
 */
export type MenuView =
  | { kind: 'list'; notice?: string; isError?: true }
  | { kind: 'memory'; name: string }
  | { kind: 'confirm'; name: string }

declare module 'claude-code' {
  interface PluginState {
    'global-memory': {
      /** What the menu's pane shows now. */
      view: Shaped<MenuView>
    }
  }
}
