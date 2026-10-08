import type { KnownSecret, VaultRequest } from '../types'

export const PANE = 'secret-vault'

// Each clipboard reader is tried in turn; the first that runs wins.
export const CLIPBOARD_READERS: readonly string[][] = [
  ['powershell', '-NoProfile', '-Command', 'Get-Clipboard -Raw'],
  ['pbpaste'],
  ['xclip', '-o', '-selection', 'clipboard'],
]

// Values typed or pasted but not yet saved. A module variable on purpose: a
// reload drops them, and they never sit in host state before the person saves.
const drafts = new Map<string, string>()

/** Keeps the latest text of a field. @example setDraft('OPENAI_API_KEY', 'sk-...') */
export function setDraft(name: string, value: string): void {
  drafts.set(name, value)
}

/** Forgets one field's value, or every value when `name` is absent. */
export function forgetDrafts(name?: string): void {
  if (name === undefined) drafts.clear()
  else drafts.delete(name)
}

/** The character count drawn beside a received value; the value itself never is. */
export function draftLength(name: string): number {
  return drafts.get(name)?.length ?? 0
}

/**
 * The request's values in slot order, or throws naming the empty ones.
 * @example collectSecrets(request) // [{ name: 'OPENAI_API_KEY', value: 'sk-...' }]
 */
export function collectSecrets(request: VaultRequest): KnownSecret[] {
  if (request.slots.length === 0) throw new Error('no key yet: type a name in "New key" or paste NAME=value lines')
  const missing = request.slots.filter(slot => !drafts.get(slot.name)?.trim())
  if (missing.length > 0) throw new Error(`still empty: ${missing.map(s => s.name).join(', ')}`)
  return request.slots.map(slot => ({ name: slot.name, value: (drafts.get(slot.name) ?? '').trim() }))
}

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*?)\s*$/

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value)
  return quoted?.[2] ?? value
}

/**
 * Reads `NAME=value` lines (a pasted .env block); comments and other lines are skipped.
 * @example parseEnvBlock('A=1\n# x\nexport B="two"') // [{ name: 'A', value: '1' }, { name: 'B', value: 'two' }]
 */
export function parseEnvBlock(text: string): KnownSecret[] {
  const found: KnownSecret[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = ENV_LINE.exec(line)
    if (match?.[1] === undefined || match[2] === undefined) continue
    const value = unquote(match[2])
    if (value !== '') found.push({ name: match[1], value })
  }
  return found
}

/**
 * Reads the "New key" field: a bare name, or `NAME=value` to fill it at once.
 * @example splitNameValue('A_KEY=abc') // { name: 'A_KEY', value: 'abc' }
 */
export function splitNameValue(raw: string): { name: string; value: string } {
  const cut = raw.indexOf('=')
  if (cut < 0) return { name: raw.trim(), value: '' }
  return { name: raw.slice(0, cut).trim(), value: unquote(raw.slice(cut + 1).trim()) }
}

/**
 * The key of the element the focus should land on next: the first empty
 * field after `from` (wrapping), else the "New key" field.
 * @example nextFocusKey(['A', 'B'], ['A'], 'A') // 'in:B'
 */
export function nextFocusKey(names: readonly string[], filled: readonly string[], from?: string): string {
  const start = from === undefined ? 0 : names.indexOf(from) + 1
  const order = [...names.slice(start), ...names.slice(0, start)]
  const empty = order.find(name => !filled.includes(name))
  return empty === undefined ? 'add-name' : `in:${empty}`
}

/** Drops older entries holding a value that was just stored again, then appends. */
export function mergeKnown(list: readonly KnownSecret[], added: readonly KnownSecret[]): KnownSecret[] {
  return [...list.filter(k => !added.some(s => s.value === k.value)), ...added]
}
