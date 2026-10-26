/** One thinking block's text, as the model's summary of it came back. */
export type Thought = string

declare module 'claude-code' {
  interface PluginState {
    'inline-thinking': {
      /** Thinking the model did since the last thing it did: not drawn yet. */
      pending: Shaped<Thought[]>
      /**
       * The thinking drawn above one row: a reply's by its row id, a tool
       * call's by its tool_use_id.
       */
      thoughts: StateFamily<Thought[]>
      /** Verbose mode is on, so the engine draws thinking itself. */
      isVerbose: boolean
    }
  }
}
