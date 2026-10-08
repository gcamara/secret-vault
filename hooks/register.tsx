import { atom, read, update } from 'claude-code'
import type { EngineInterface, Hook, Register } from 'claude-code'

import type { KnownSecret, VaultFormat, VaultRequest, VaultSlot } from '../types'
import {
  CLIPBOARD_READERS,
  PANE,
  collectSecrets,
  draftLength,
  forgetDrafts,
  mergeKnown,
  nextFocusKey,
  parseEnvBlock,
  setDraft,
  splitNameValue,
} from './drafts'
import { applySecrets, existingKeys, splitPath } from './formats'
import { redactBlock } from './redact'
import { GUIDANCE, TOOL_SPEC, checkSlotName, parseCommandArgs, parseToolInput } from './request'

// Every function that touches `$` lives in this file: the engine follows `$`
// only into functions declared in the hooks module itself, never across an import.
// The state atoms are here for the same reason: the scan reads them only in this file.

const pendingAtom = atom({ plugin: 'secret-vault', key: 'pending' } as const, null)
const filledAtom = atom({ plugin: 'secret-vault', key: 'filled' } as const, [])
const knownAtom = atom({ plugin: 'secret-vault', key: 'known' } as const, [])
const errorAtom = atom({ plugin: 'secret-vault', key: 'error' } as const, null)

type RenderEvent = Parameters<Hook<'ui.render'>>[1]

const FORMAT_OPTIONS = [
  { value: 'env', label: 'env   NAME=value lines' },
  { value: 'json', label: 'json  dotted keys in an object' },
  { value: 'raw', label: 'raw   the file is the value' },
] as const

// ── actions ────────────────────────────────────────────────────────────────

async function reopenPane($: EngineInterface, request: VaultRequest): Promise<void> {
  const rows = 16 + request.slots.length * 2
  await $.ui.open({ id: PANE, title: 'Secret vault', focus: true, closeOnEscape: true, holdToasts: true, rows })
}

async function openRequest($: EngineInterface, request: VaultRequest): Promise<void> {
  forgetDrafts()
  await update($, pendingAtom, () => request)
  await update($, filledAtom, () => [])
  await update($, errorAtom, () => null)
  await reopenPane($, request)
}

async function showError($: EngineInterface, error: unknown): Promise<void> {
  await update($, errorAtom, () => (error instanceof Error ? error.message : String(error)))
}

// Best effort: the keyboard is the person's, so a refused or failed move is fine.
function moveFocus($: EngineInterface, key: string): void {
  $.ui.focus({ requestId: PANE, key }).catch(() => undefined)
}

// Moves the ring to the next empty field, so pasting several keys is paste, Enter, paste, Enter.
async function focusNext($: EngineInterface, from?: string): Promise<void> {
  const request = await read($, pendingAtom)
  if (request === null) return
  const filled = await read($, filledAtom)
  moveFocus($, nextFocusKey(request.slots.map(s => s.name), filled, from))
}

async function confirmDraft($: EngineInterface, name: string, value: string): Promise<void> {
  const trimmed = value.trim()
  if (trimmed === '') return
  setDraft(name, trimmed)
  await update($, filledAtom, list => (list.includes(name) ? list : [...list, name]))
  await update($, errorAtom, () => null)
}

async function clearDraft($: EngineInterface, name: string): Promise<void> {
  forgetDrafts(name)
  await update($, filledAtom, list => list.filter(one => one !== name))
  moveFocus($, `in:${name}`)
}

async function removeSlot($: EngineInterface, name: string): Promise<void> {
  forgetDrafts(name)
  await update($, filledAtom, list => list.filter(one => one !== name))
  await update($, pendingAtom, request => request && { ...request, slots: request.slots.filter(s => s.name !== name) })
  await focusNext($)
}

async function insertSlot($: EngineInterface, name: string): Promise<void> {
  await update($, pendingAtom, request => {
    if (request === null || request.slots.some(slot => slot.name === name)) return request
    return { ...request, slots: [...request.slots, { name, hint: '' }] }
  })
}

// "New key" takes a bare name (a field appears for the value) or NAME=value (filled at once).
async function addSlot($: EngineInterface, raw: string): Promise<void> {
  try {
    const typed = splitNameValue(raw)
    const name = checkSlotName(typed.name)
    await insertSlot($, name)
    if (typed.value !== '') await confirmDraft($, name, typed.value)
    await update($, errorAtom, () => null)
    moveFocus($, typed.value === '' ? `in:${name}` : 'add-name')
  } catch (error) {
    await showError($, error)
  }
}

async function setFormat($: EngineInterface, value: string): Promise<void> {
  const format = FORMAT_OPTIONS.find(option => option.value === value)?.value
  if (format === undefined) return
  await update($, pendingAtom, request => request && { ...request, format: format as VaultFormat })
}

async function readClipboard($: EngineInterface): Promise<string> {
  for (const argv of CLIPBOARD_READERS) {
    try {
      const ran = await $.process.run(argv, { timeoutMs: 5000 })
      if (ran.exitCode === 0) return ran.stdout.replace(/\r?\n$/, '')
    } catch {
      // that reader is not installed here; try the next one
    }
  }
  throw new Error(`no clipboard reader worked; tried ${CLIPBOARD_READERS.map(a => a[0]).join(', ')}`)
}

async function pasteDraft($: EngineInterface, name: string): Promise<void> {
  try {
    const value = await readClipboard($)
    if (value.trim() === '') throw new Error('the clipboard is empty; copy the key first')
    await confirmDraft($, name, value)
    await focusNext($, name)
  } catch (error) {
    await showError($, error)
  }
}

// Fills several keys at once from copied `NAME=value` lines; the values are never drawn.
async function pasteEnvBlock($: EngineInterface): Promise<void> {
  try {
    const found = parseEnvBlock(await readClipboard($))
    if (found.length === 0) throw new Error('no NAME=value line in the clipboard; copy lines like OPENAI_API_KEY=sk-...')
    for (const one of found) {
      await insertSlot($, checkSlotName(one.name))
      await confirmDraft($, one.name, one.value)
    }
    await focusNext($)
  } catch (error) {
    await showError($, error)
  }
}

async function writeSecrets($: EngineInterface, request: VaultRequest, secrets: KnownSecret[]): Promise<void> {
  const isPresent = request.format !== 'raw' && (await $.fs.exists(request.path))
  const current = isPresent ? await $.fs.read(request.path) : ''
  await $.fs.write(request.path, applySecrets(current, secrets, request.format))
}

async function finish($: EngineInterface, request: VaultRequest, outcome: string): Promise<void> {
  forgetDrafts()
  await update($, pendingAtom, () => null)
  await update($, filledAtom, () => [])
  await update($, errorAtom, () => null)
  await $.ui.close({ id: PANE })
  $.ui.toast(`secret-vault: ${outcome}`)
  if (request.origin !== 'tool') return
  const tail = 'The values are never shown to you; refer to them by name. Continue the task.'
  void $.prompt.submit({ text: `[secret-vault] The user ${outcome}. ${tail}` })
}

async function saveRequest($: EngineInterface): Promise<void> {
  const request = await read($, pendingAtom)
  if (request === null) return
  try {
    const secrets = collectSecrets(request)
    await writeSecrets($, request, secrets)
    await update($, knownAtom, list => mergeKnown(list, secrets))
    await finish($, request, `saved ${secrets.map(s => s.name).join(', ')} to ${request.path} (${request.format})`)
  } catch (error) {
    await showError($, error)
    await focusNext($)
  }
}

async function cancelRequest($: EngineInterface): Promise<void> {
  const request = await read($, pendingAtom)
  if (request === null) return
  const names = request.slots.map(s => s.name).join(', ')
  await finish($, request, names === '' ? 'cancelled the secret request' : `cancelled the request for ${names}`)
}

// `/secret` alone reopens a pending request; `/secret [file]` starts a new one
// (default .env). Names and values are typed only inside the modal.
async function runSecretCommand($: EngineInterface, args: string): Promise<{ text: string }> {
  const pending = await read($, pendingAtom)
  if (args.trim() === '' && pending !== null) {
    await reopenPane($, pending)
    return { text: 'Secret vault reopened.' }
  }
  const request = parseCommandArgs(args, `cmd-${Date.now()}`)
  await openRequest($, request)
  return { text: `Secret vault opened for ${request.path}.` }
}

// ── drawing ────────────────────────────────────────────────────────────────

async function readExistingKeys($: EngineInterface, request: VaultRequest): Promise<string[]> {
  try {
    if (!(await $.fs.exists(request.path))) return []
    return existingKeys(await $.fs.read(request.path), request.format)
  } catch {
    return []
  }
}

function drawHeader($: EngineInterface, e: RenderEvent, request: VaultRequest, ready: number) {
  if (e.surface === 'mobile') return null
  const { Box, Text, Select } = $.ui.resolve(e)
  const { dir, base } = splitPath(request.path)
  const total = request.slots.length
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="claude">Secret vault</Text>
        <Text color={total > 0 && ready === total ? 'success' : 'subtle'}>{ready}/{total} ready</Text>
      </Box>
      {request.reason !== '' && <Text>{request.reason}</Text>}
      <Box flexDirection="row" marginTop={1}>
        <Text dimColor>File    </Text>
        <Text dimColor wrap="truncate-start">{dir}</Text>
        <Text bold>{base}</Text>
      </Box>
      <Select key="format" label="Format  " value={request.format} options={FORMAT_OPTIONS} onSelect={value => void setFormat($, value)} />
    </Box>
  )
}

function drawSlotTag($: EngineInterface, e: RenderEvent, isExisting: boolean) {
  const { Text } = $.ui.resolve(e)
  return isExisting ? <Text color="warning"> replaces existing</Text> : <Text dimColor> new</Text>
}

function drawReceived($: EngineInterface, e: RenderEvent, slot: VaultSlot, isExisting: boolean) {
  if (e.surface === 'mobile') return null
  const { Box, Text, Button } = $.ui.resolve(e)
  return (
    <Box key={`row:${slot.name}`} flexDirection="row" justifyContent="space-between">
      <Box flexDirection="row">
        <Text color="success">● </Text>
        <Text bold>{slot.name}</Text>
        <Text dimColor>  •••••••• {draftLength(slot.name)} chars</Text>
        {drawSlotTag($, e, isExisting)}
      </Box>
      <Box flexDirection="row" gap={1}>
        <Button key={`clear:${slot.name}`} plain dimColor onPress={() => void clearDraft($, slot.name)}>replace</Button>
        <Button key={`drop:${slot.name}`} plain dimColor onPress={() => void removeSlot($, slot.name)}>remove</Button>
      </Box>
    </Box>
  )
}

function drawField($: EngineInterface, e: RenderEvent, slot: VaultSlot, isExisting: boolean, isFirst: boolean) {
  if (e.surface === 'mobile') return null
  const { Box, Text, Input, Button } = $.ui.resolve(e)
  return (
    <Box key={`row:${slot.name}`} flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row">
          <Text color="subtle">○ </Text>
          <Text bold>{slot.name}</Text>
          {drawSlotTag($, e, isExisting)}
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button key={`paste:${slot.name}`} plain dimColor onPress={() => void pasteDraft($, slot.name)}>from clipboard</Button>
          <Button key={`drop:${slot.name}`} plain dimColor onPress={() => void removeSlot($, slot.name)}>remove</Button>
        </Box>
      </Box>
      <Input
        key={`in:${slot.name}`}
        label="  "
        placeholder={slot.hint !== '' ? `paste the value (${slot.hint})` : 'paste the value, then Enter'}
        submitLabel="keep"
        autoFocus={isFirst ? true : undefined}
        onInput={value => setDraft(slot.name, value)}
        onSubmit={value => void confirmDraft($, slot.name, value).then(() => focusNext($, slot.name))}
      />
    </Box>
  )
}

function drawAddRow($: EngineInterface, e: RenderEvent, isFirst: boolean) {
  if (e.surface === 'mobile') return null
  const { Box, Input, Button } = $.ui.resolve(e)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Input
        key="add-name"
        label="+ "
        placeholder="new key: NAME, or NAME=value"
        submitLabel="add"
        value=""
        autoFocus={isFirst ? true : undefined}
        onSubmit={value => void addSlot($, value)}
      />
      <Button key="paste-block" plain dimColor onPress={() => void pasteEnvBlock($)}>+ paste several NAME=value lines from the clipboard</Button>
    </Box>
  )
}

function drawFooter($: EngineInterface, e: RenderEvent, ready: number, error: string | null) {
  if (e.surface === 'mobile') return null
  const { Box, Text, Button } = $.ui.resolve(e)
  const saveLabel = ready === 0 ? 'Save' : `Save ${ready} key${ready === 1 ? '' : 's'}`
  return (
    <Box flexDirection="column" marginTop={1}>
      {error !== null && <Text color="error">✗ {error}</Text>}
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" gap={1}>
          <Button key="save" variant="primary" onPress={() => void saveRequest($)}>{saveLabel}</Button>
          <Button key="cancel" role="dismiss" onPress={() => void cancelRequest($)}>Cancel</Button>
        </Box>
        <Text dimColor>Tab next · Enter keep · Esc hide (/secret reopens)</Text>
      </Box>
      <Text dimColor>Values go straight to the file and never enter the conversation.</Text>
    </Box>
  )
}

async function renderVault($: EngineInterface, e: RenderEvent) {
  const { Box, Text } = $.ui.resolve(e)
  const request = await read($, pendingAtom)
  if (request === null) return <Text dimColor>No secret requested. Run /secret [file] to start.</Text>
  if (e.surface === 'mobile') return <Text>Open this session on the terminal or desktop to paste the keys.</Text>
  const filled = await read($, filledAtom)
  const error = await read($, errorAtom)
  const existing = await readExistingKeys($, request)
  const ready = request.slots.filter(slot => filled.includes(slot.name)).length
  const firstEmpty = request.slots.find(slot => !filled.includes(slot.name))?.name
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
      {drawHeader($, e, request, ready)}
      <Box flexDirection="column" marginTop={1}>
        {request.slots.map(slot => filled.includes(slot.name)
          ? drawReceived($, e, slot, existing.includes(slot.name))
          : drawField($, e, slot, existing.includes(slot.name), slot.name === firstEmpty))}
      </Box>
      {drawAddRow($, e, firstEmpty === undefined)}
      {drawFooter($, e, ready, error)}
    </Box>
  )
}

// ── tool and registration ──────────────────────────────────────────────────

type SecretToolAnswer = { result: string } | { deny: string }

async function answerSecretTool($: EngineInterface, input: Readonly<Record<string, unknown>>): Promise<SecretToolAnswer> {
  try {
    const id = typeof input.tool_use_id === 'string' ? input.tool_use_id : `tool-${Date.now()}`
    const request = parseToolInput(input, id)
    await openRequest($, request)
    const names = request.slots.map(s => s.name).join(', ')
    return { result: `Modal opened for ${names} -> ${request.path}. End your turn now; a message arrives when the user saves or cancels.` }
  } catch (error) {
    return { deny: `secret-vault: ${(error as Error).message}` }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register(TOOL_SPEC)
    await $.command.register({ name: 'secret', description: 'Open a private modal to paste API keys into a file (default .env)', argumentHint: '[file]' })
    return next(e)
  })

  on('command.run', { command: 'secret' }, ($, e) => runSecretCommand($, e.args))

  on('tool.call', { tool: 'mcp__secret-vault__request_secrets' }, ($, e) => answerSecretTool($, e)).catch(($, e, next) =>
    next.called ? next(e) : { deny: `secret-vault: could not open the modal; ask again or run /secret` },
  )

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'secret-vault:guidance', text: GUIDANCE, scope: 'session' }] }
  })

  // Every user-side row (prompts, tool results, injected files) is scrubbed
  // before it is stored, so a key read back from disk never reaches the model.
  on('session.append', async ($, e, next) => {
    if (e.message.type === 'assistant' || e.message.type === 'system') return next(e)
    const known = await read($, knownAtom)
    const content = e.message.content.map(block => redactBlock(block, known))
    return next({ ...e, message: { ...e.message, content } })
  }).catch(($, e, next) => {
    // Without the known values, still strip the well-known key shapes.
    if (next.called) return next(e)
    const content = e.message.content.map(block => redactBlock(block, []))
    return next({ ...e, message: { ...e.message, content } })
  })

  on('ui.render', { component: 'Pane', requestId: 'secret-vault' }, ($, e) => renderVault($, e))
}
