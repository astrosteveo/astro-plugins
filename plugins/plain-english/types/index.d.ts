/** The main thread's last answer, as its turn ended. */
export type Reply = string

declare module 'claude-code' {
  interface PluginState {
    'plain-english': {
      /** The answer a scan given no path or text reads. */
      lastReply: Reply
    }
  }
}
