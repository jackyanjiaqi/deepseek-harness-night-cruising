/** File + logger bridge: every line stays local and never contains account secrets. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const IPV4 = /\b(?!127\.0\.0\.1\b)(?:\d{1,3}\.){3}\d{1,3}\b/g

/**
 * Redact what a support bundle or a screenshot must not carry: the local home
 * path, LAN/tailnet addresses (loopback is kept for debugging) and anything
 * that looks like a bearer token or a named secret.
 */
export function redactLogText(value) {
  let text = String(value)
  const home = os.homedir()
  if (home) text = text.split(home).join('~')
  text = text.replace(IPV4, 'x.x.x.x')
  text = text.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 <redacted>')
  text = text.replace(/\b(token|secret|password|passcode)=([^\s&]+)/gi, '$1=<redacted>')
  return text
}

export function createLog({ dir, debug, logger, maxBytes = DEFAULT_MAX_BYTES }) {
  const file = path.join(dir, 'mesh.log')
  let writes = 0

  const rotate = () => {
    try {
      if (fs.statSync(file).size <= maxBytes) return
      fs.rmSync(`${file}.2`, { force: true })
      fs.renameSync(file, `${file}.1`)
    } catch {
      // Missing file / rename failure: keep appending rather than break.
    }
  }
  rotate()

  const write = (level, args) => {
    const raw = args
      .map(value => (typeof value === 'string' ? value : safeString(value)))
      .join(' ')
      .replace(/\s+/g, ' ')
      .slice(0, 4000)
    const message = redactLogText(raw)
    const line = `${new Date().toISOString()} ${level} ${message}\n`
    try {
      fs.appendFileSync(file, line, { mode: 0o600 })
    } catch {
      // Logging must never break the mesh.
    }
    writes += 1
    if (writes >= 200) {
      writes = 0
      rotate()
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
