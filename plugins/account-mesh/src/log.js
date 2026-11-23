/** File + logger bridge: every line stays local and never contains account secrets. */
import fs from 'node:fs'
import path from 'node:path'

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])

export function createLog({ dir, debug, logger }) {
  const file = path.join(dir, 'mesh.log')
  const write = (level, args) => {
    const message = args
      .map(value => (typeof value === 'string' ? value : safeString(value)))
      .join(' ')
      .replace(/\s+/g, ' ')
      .slice(0, 4000)
    const line = `${new Date().toISOString()} ${level} ${message}\n`
    try {
      fs.appendFileSync(file, line, { mode: 0o600 })
    } catch {
      // Logging must never break the mesh.
    }
    if (!debug) return
    try {
      const sink = logger?.[level]
      if (typeof sink === 'function') sink.call(logger, `account-mesh: ${message}`)
    } catch {
      // ignore
    }
  }
  const log = { file }
  for (const level of LEVELS) log[level] = (...args) => write(level, args)
  return log
}

function safeString(value) {
  try {
    if (value instanceof Error) return `${value.name}: ${value.message}`
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
