import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

test('client only calls the observable store methods it actually defines', () => {
  // Regression guard: an effect once called `docStore.retain()` although the
  // retain/refresh helpers are standalone functions. React runs effects only
  // in the browser, so the server-render smoke test could not catch it.
  const calls = [...source.matchAll(/\bdocStore\.([A-Za-z_$][\w$]*)/g)].map(match => match[1])
  const allowed = new Set(['getSnapshot', 'set', 'subscribe'])
  assert.deepEqual([...new Set(calls.filter(name => !allowed.has(name)))], [])
})

test('settings page renders the version served by /api/list', () => {
  // The badge mirrors account-mesh: the Host reads package.json and serves it
  // on /api/list, and the settings title renders it as `v<version>`.
  assert.match(source, /typeof result\.version === 'string'/)
  assert.match(source, /className: 'dsd-title-version'/)
  assert.match(source, /`v\$\{snapshot\.version\}`/)
})
