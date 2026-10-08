/** How a target file stores secrets: `NAME=value` lines, a JSON object, or the bare value. */
export type VaultFormat = 'env' | 'json' | 'raw'

/** One secret the modal asks for: its key in the target file and a hint drawn under it. */
export type VaultSlot = { name: string; hint: string }

/** A pending request: where the secrets go and who asked (the model's tool or /secret). */
export type VaultRequest = {
  id: string
  path: string
  format: VaultFormat
  slots: VaultSlot[]
  reason: string
  origin: 'tool' | 'command'
}

/** A value already written, kept for the session so it can be redacted from every row. */
export type KnownSecret = { name: string; value: string }

declare module 'claude-code' {
  interface PluginState {
    'secret-vault': {
      pending: VaultRequest | null
      filled: string[]
      known: KnownSecret[]
      error: string | null
    }
  }
}
