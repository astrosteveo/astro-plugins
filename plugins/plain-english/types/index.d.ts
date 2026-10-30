/** The main thread's last answer, as its turn ended. */
export type Reply = string

/** A time in whole seconds since 1970, as git counts commit times. */
export type Seconds = number

declare module 'claude-code' {
  interface PluginState {
    'plain-english': {
      /** The answer a scan given no path or text reads. */
      lastReply: Reply
      /** When the session started: only commits made since are Claude's to answer for. */
      sessionStart: Seconds
    }
  }
}
