import { expect, test } from 'claude-code/testing'

const PANE_PROPS = {
  title: 'Secret vault',
  isFocused: true,
  bodyColumns: 90,
  placement: 'inline',
  scroll: { top: 0, bodyRows: 30 },
  view: {},
} as const

const TYPED_VALUE = 'typed-secret-value-123'
const ADDED_VALUE = 'added-secret-value-456'

test('the modal fills keys without ever drawing a value', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    await $.tool.call({ tool: 'mcp__secret-vault__request_secrets', path: 'vault/.env', secrets: [{ name: 'A_KEY', hint: 'from the dashboard' }] })
    const ui = await $.ui.mount({ plugin: 'secret-vault', surface, component: 'Pane', requestId: 'secret-vault', props: PANE_PROPS as never })
    expect(await ui.find({ type: 'Text', text: '0/1 ready' })).toBeDefined()

    await ui.input({ key: 'in:A_KEY', text: TYPED_VALUE })
    await ui.input({ key: 'add-name', text: `B_KEY=${ADDED_VALUE}` })
    expect(await ui.find({ type: 'Text', text: '2/2 ready' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'save' })).toMatchObject({ text: 'Save 2 keys' })

    const drawing = JSON.stringify(await ui.drawn())
    expect(drawing.includes(TYPED_VALUE) || drawing.includes(ADDED_VALUE)).toBe(false)

    await ui.press({ key: 'drop:B_KEY' })
    expect(await ui.find({ type: 'Text', text: '1/1 ready' })).toBeDefined()
    await ui.unmount()
  }
})

test('a bad name in "New key" shows the offending value', async $ => {
  await $.tool.call({ tool: 'mcp__secret-vault__request_secrets', path: '.env', secrets: [{ name: 'A_KEY' }] })
  const ui = await $.ui.mount({ plugin: 'secret-vault', surface: 'terminal', component: 'Pane', requestId: 'secret-vault', props: PANE_PROPS as never })
  await ui.input({ key: 'add-name', text: 'has space' })
  expect(await ui.find({ type: 'Text', text: /"has space"/ })).toBeDefined()
  await ui.unmount()
})
