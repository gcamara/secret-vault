import { expect, test } from 'claude-code/testing'

import { applySecrets, detectFormat, existingKeys, splitPath, upsertEnvLine } from './formats'
import { nextFocusKey, splitNameValue } from './drafts'

test('existingKeys lists env names and dotted json leaves', () => {
  expect(existingKeys('# c\nA=1\nexport B=2\n', 'env')).toEqual(['A', 'B'])
  expect(existingKeys('{"x":{"y":1},"z":2}', 'json')).toEqual(['x.y', 'z'])
  expect(existingKeys('not json', 'json')).toEqual([])
})

test('splitPath separates folder and file on both separators', () => {
  expect(splitPath('C:\\a\\b\\.env')).toEqual({ dir: 'C:\\a\\b\\', base: '.env' })
  expect(splitPath('.env')).toEqual({ dir: '', base: '.env' })
})

test('splitNameValue reads a bare name or NAME=value', () => {
  expect(splitNameValue(' A_KEY ')).toEqual({ name: 'A_KEY', value: '' })
  expect(splitNameValue('A_KEY="x=y"')).toEqual({ name: 'A_KEY', value: 'x=y' })
})

test('nextFocusKey walks to the next empty field, then to New key', () => {
  expect(nextFocusKey(['A', 'B', 'C'], ['A'], 'A')).toBe('in:B')
  expect(nextFocusKey(['A', 'B'], ['B'], 'B')).toBe('in:A')
  expect(nextFocusKey(['A'], ['A'], 'A')).toBe('add-name')
})

test('detectFormat picks json by extension and env otherwise', () => {
  expect(detectFormat('config\\appsettings.json')).toBe('json')
  expect(detectFormat('.env.local')).toBe('env')
})

test('upsertEnvLine replaces an existing line and keeps export', () => {
  const text = 'A=1\nexport KEY=old\nB=2\n'
  expect(upsertEnvLine(text, { name: 'KEY', value: 'new' })).toBe('A=1\nexport KEY=new\nB=2\n')
})

test('upsertEnvLine appends and quotes values with spaces', () => {
  expect(upsertEnvLine('A=1', { name: 'K', value: 'a b' })).toBe('A=1\nK="a b"\n')
})

test('applySecrets sets dotted keys in json and keeps other keys', () => {
  const out = applySecrets('{"x":1}', [{ name: 'OpenAI.ApiKey', value: 'v' }], 'json')
  expect(JSON.parse(out)).toEqual({ x: 1, OpenAI: { ApiKey: 'v' } })
})

test('applySecrets raw refuses more than one secret', () => {
  const two = [{ name: 'A', value: '1' }, { name: 'B', value: '2' }]
  expect(() => applySecrets('', two, 'raw')).toThrow('exactly one')
})
