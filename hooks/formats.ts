import type { KnownSecret, VaultFormat } from '../types'

/**
 * Picks the storage format from the target path when the caller named none.
 * @example detectFormat('config/appsettings.json') // 'json'
 */
export function detectFormat(path: string): VaultFormat {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? ''
  if (/\.json$/i.test(base)) return 'json'
  return 'env'
}

/**
 * Returns the file text with each secret upserted in the given format.
 * @example applySecrets('A=1\n', [{ name: 'B', value: 'x' }], 'env') // 'A=1\nB=x\n'
 */
export function applySecrets(current: string, secrets: KnownSecret[], format: VaultFormat): string {
  if (format === 'raw') return applyRaw(secrets)
  if (format === 'json') return applyJson(current, secrets)
  return secrets.reduce((text, one) => upsertEnvLine(text, one), current)
}

function applyRaw(secrets: KnownSecret[]): string {
  const [only] = secrets
  if (secrets.length !== 1 || only === undefined) {
    throw new Error(`raw format holds exactly one secret, got ${secrets.length}: ${secrets.map(s => s.name).join(', ')}`)
  }
  return only.value
}

function quoteEnvValue(value: string): string {
  if (!/[\s#"'\\]/.test(value)) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Replaces `NAME=` (keeping a leading `export`) or appends the line at the end. */
export function upsertEnvLine(text: string, secret: KnownSecret): string {
  const line = `${secret.name}=${quoteEnvValue(secret.value)}`
  const pattern = new RegExp(`^(\\s*(?:export\\s+)?)${escapeRegExp(secret.name)}\\s*=.*$`, 'm')
  if (pattern.test(text)) return text.replace(pattern, (_m, lead: string) => lead + line)
  const base = text === '' || text.endsWith('\n') ? text : `${text}\n`
  return `${base}${line}\n`
}

function parseJsonObject(current: string): Record<string, unknown> {
  if (current.trim() === '') return {}
  const parsed: unknown = JSON.parse(current)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`target JSON must be an object at the top level, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`)
  }
  return parsed as Record<string, unknown>
}

/** Sets `a.b.c` inside the object, creating the objects on the way. */
export function setDotted(root: Record<string, unknown>, dotted: string, value: string): void {
  const keys = dotted.split('.')
  const last = keys.pop() ?? dotted
  let node = root
  for (const key of keys) {
    const next = node[key]
    if (next === null || typeof next !== 'object' || Array.isArray(next)) node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[last] = value
}

/**
 * Splits a path into the folder (dim in the modal) and the file name (bold).
 * @example splitPath('C:\\a\\b\\.env') // { dir: 'C:\\a\\b\\', base: '.env' }
 */
export function splitPath(path: string): { dir: string; base: string } {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1
  return { dir: path.slice(0, cut), base: path.slice(cut) }
}

function flattenKeys(node: unknown, prefix: string): string[] {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return prefix === '' ? [] : [prefix]
  return Object.entries(node).flatMap(([key, child]) => flattenKeys(child, prefix === '' ? key : `${prefix}.${key}`))
}

/**
 * Names the file already holds, so the modal can say "replaces" or "new".
 * A file that does not parse holds none, as far as the modal is concerned.
 * @example existingKeys('A=1\nexport B=2', 'env') // ['A', 'B']
 */
export function existingKeys(text: string, format: VaultFormat): string[] {
  if (format === 'raw') return []
  if (format === 'env') return [...text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/gm)].map(m => m[1] ?? '')
  try {
    return flattenKeys(JSON.parse(text), '')
  } catch {
    return []
  }
}

function applyJson(current: string, secrets: KnownSecret[]): string {
  const root = parseJsonObject(current)
  for (const one of secrets) setDotted(root, one.name, one.value)
  return `${JSON.stringify(root, null, 2)}\n`
}
