import { expect, test } from 'claude-code/testing'

import { redactBlock, redactText } from './redact'
import { checkSlotName, parseCommandArgs, parseToolInput } from './request'
import { parseEnvBlock } from './drafts'

test('redactText replaces known values by name', () => {
  expect(redactText('KEY=supersecret1', [{ name: 'KEY', value: 'supersecret1' }])).toBe('KEY=[secret:KEY]')
})

test('redactText strips well-known key shapes', () => {
  expect(redactText('x sk-ant-abcdefghijklmnopqrstuvwxyz y', [])).toBe('x [redacted-secret] y')
  expect(redactText('AKIAABCDEFGHIJKLMNOP', [])).toBe('[redacted-secret]')
})

test('redactBlock scrubs tool_result content in string and block form', () => {
  const known = [{ name: 'K', value: 'value-123456' }]
  const asText = redactBlock({ type: 'tool_result', tool_use_id: 't', content: 'K=value-123456' }, known)
  expect(asText.content).toBe('K=[secret:K]')
  const asBlocks = redactBlock({ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'value-123456' }] }, known)
  expect(asBlocks.content).toEqual([{ type: 'text', text: '[secret:K]' }])
})

test('parseToolInput rejects a bad name with the offending value', () => {
  expect(() => parseToolInput({ path: '.env', secrets: [{ name: '1 bad' }] }, 'id')).toThrow('"1 bad"')
})

test('parseCommandArgs takes only the file and defaults to .env', () => {
  const request = parseCommandArgs('config/app.json', 'c')
  expect(request).toEqual({ id: 'c', path: 'config/app.json', format: 'json', slots: [], reason: '', origin: 'command' })
  expect(parseCommandArgs('  ', 'd').path).toBe('.env')
})

test('checkSlotName trims and rejects bad names', () => {
  expect(checkSlotName(' OPENAI_API_KEY ')).toBe('OPENAI_API_KEY')
  expect(() => checkSlotName('has space')).toThrow('"has space"')
})

test('parseEnvBlock reads NAME=value lines and skips the rest', () => {
  const block = '# keys\nA_KEY=one\r\nexport B_KEY="two words"\nnot a line\nEMPTY='
  expect(parseEnvBlock(block)).toEqual([
    { name: 'A_KEY', value: 'one' },
    { name: 'B_KEY', value: 'two words' },
  ])
})
