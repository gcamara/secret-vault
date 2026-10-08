import type { ToolSpec } from 'claude-code'

import type { VaultFormat, VaultRequest, VaultSlot } from '../types'
import { detectFormat } from './formats'

export const TOOL_NAME = 'request_secrets'
export const TOOL_ID = `mcp__secret-vault__${TOOL_NAME}`

const NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/
const FORMATS: readonly VaultFormat[] = ['env', 'json', 'raw']

export const TOOL_SPEC: ToolSpec = {
  name: TOOL_NAME,
  isDeferred: false,
  description:
    'Ask the user for one or more secrets (API keys, tokens, passwords) in a private modal. ' +
    'The values are written straight to `path` and never reach the conversation. ' +
    'Returns at once; end your turn after calling it. A message arrives when the user saves or cancels.',
  inputSchema: {
    type: 'object',
    required: ['path', 'secrets'],
    properties: {
      path: { type: 'string', description: 'File that will hold the secrets (absolute, or relative to the working directory), e.g. ".env".' },
      format: { type: 'string', enum: FORMATS, description: 'env: NAME=value lines (default; .json paths default to json). json: dotted keys inside a JSON object. raw: the whole file is the one value.' },
      reason: { type: 'string', description: 'One line shown to the user: what the keys are for.' },
      secrets: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: 'Variable name, or dotted JSON key (e.g. "OpenAI.ApiKey").' },
            hint: { type: 'string', description: 'Where the user gets it, e.g. "platform.openai.com > API keys".' },
          },
        },
      },
    },
  },
}

function readSlot(raw: unknown): VaultSlot {
  const item = (raw ?? {}) as { name?: unknown; hint?: unknown }
  const name = typeof item.name === 'string' ? item.name.trim() : ''
  if (!NAME_SHAPE.test(name)) {
    throw new Error(`secret name ${JSON.stringify(item.name)} is invalid; expected letters, digits, _ . - (e.g. "OPENAI_API_KEY")`)
  }
  return { name, hint: typeof item.hint === 'string' ? item.hint : '' }
}

function readFormat(raw: unknown, path: string): VaultFormat {
  if (raw === undefined) return detectFormat(path)
  if (FORMATS.includes(raw as VaultFormat)) return raw as VaultFormat
  throw new Error(`format ${JSON.stringify(raw)} is invalid; expected one of ${FORMATS.join(', ')}`)
}

/**
 * Turns the model's tool input into a pending request, or throws saying what is wrong.
 * @example parseToolInput({ path: '.env', secrets: [{ name: 'OPENAI_API_KEY' }] }, 'id1')
 */
export function parseToolInput(input: Record<string, unknown>, id: string): VaultRequest {
  const path = typeof input.path === 'string' ? input.path.trim() : ''
  if (path === '') throw new Error(`path ${JSON.stringify(input.path)} is invalid; expected a file path such as ".env"`)
  if (!Array.isArray(input.secrets) || input.secrets.length === 0) {
    throw new Error(`secrets ${JSON.stringify(input.secrets)} is invalid; expected [{ "name": "OPENAI_API_KEY" }, ...]`)
  }
  const format = readFormat(input.format, path)
  const slots = input.secrets.map(readSlot)
  if (format === 'raw' && slots.length !== 1) throw new Error(`raw format takes exactly one secret, got ${slots.length}`)
  const reason = typeof input.reason === 'string' ? input.reason : ''
  return { id, path, format, slots, reason, origin: 'tool' }
}

/**
 * Parses `/secret [path]`: only the target file, never a name or value, so
 * nothing about the keys lands in the conversation. Names are added in the modal.
 * @example parseCommandArgs('config/.env', 'c1') // { path: 'config/.env', slots: [] }
 */
export function parseCommandArgs(args: string, id: string): VaultRequest {
  const path = args.trim() === '' ? '.env' : args.trim()
  return { id, path, format: detectFormat(path), slots: [], reason: '', origin: 'command' }
}

/**
 * Validates a name typed in the modal's "new key" field.
 * @example checkSlotName(' OPENAI_API_KEY ') // 'OPENAI_API_KEY'
 */
export function checkSlotName(raw: string): string {
  return readSlot({ name: raw }).name
}

/** What the model reads in the system prompt so it reaches for the tool instead of the chat. */
export const GUIDANCE = [
  '# Secrets (secret-vault plugin)',
  `- When a task needs an API key, token, password or any credential, never ask the user to paste it in chat and never leave a placeholder for them to fill. Call ${TOOL_ID} with the names and the file that should hold them; the user pastes them in a private modal and the plugin writes the file. End your turn after the call; a message tells you when they are saved.`,
  '- Never print, echo, cat or log secret values; refer to them by name.',
  '- Text shown as [secret:NAME] or [redacted-secret] was redacted on purpose. Do not try to recover it. To change such a value, call the tool again; when editing a file that holds secrets, edit only lines that do not contain them.',
].join('\n')
