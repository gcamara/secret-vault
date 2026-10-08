import type { KnownSecret } from '../types'

// Well-known credential shapes, so a key that never went through the modal
// (an old .env read back, a pasted prompt) still stays out of the transcript.
const KEY_SHAPES: readonly RegExp[] = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

// Shorter values would match ordinary words; the shapes above cover short tokens.
const MIN_KNOWN_LENGTH = 6

/**
 * Replaces every stored secret value and every well-known key shape in `text`.
 * @example redactText('k=sk-abc...', []) // 'k=[redacted-secret]'
 */
export function redactText(text: string, known: readonly KnownSecret[]): string {
  let out = text
  for (const one of known) {
    if (one.value.length < MIN_KNOWN_LENGTH) continue
    out = out.split(one.value).join(`[secret:${one.name}]`)
  }
  for (const shape of KEY_SHAPES) out = out.replace(shape, '[redacted-secret]')
  return out
}

type Block = { type: string; [field: string]: unknown }

function redactNested(content: unknown, known: readonly KnownSecret[]): unknown {
  if (typeof content === 'string') return redactText(content, known)
  if (!Array.isArray(content)) return content
  return content.map(block => redactBlock(block as Block, known))
}

/** Redacts a text block's text and a tool_result's content; other blocks pass as they are. */
export function redactBlock(block: Block, known: readonly KnownSecret[]): Block {
  if (block.type === 'text' && typeof block.text === 'string') {
    return { ...block, text: redactText(block.text, known) }
  }
  if (block.type === 'tool_result') return { ...block, content: redactNested(block.content, known) }
  return block
}
