function isTauriRuntime() {
  try {
    return Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__)
  } catch {
    return false
  }
}

function safeToString(value) {
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`
  }

  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return String(value)

  try {
    return JSON.stringify(value, (key, v) => {
      if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`
      if (typeof v === 'bigint') return v.toString()
      return v
    })
  } catch {
    try {
      return String(value)
    } catch {
      return '[unprintable]'
    }
  }
}

function formatArgs(args) {
  return args.map(safeToString).join(' ')
}

export async function installTauriTerminalLogging() {
  if (!isTauriRuntime()) return
  if (window.__GUV_TAURI_TERMINAL_LOGGING_INSTALLED__) return
  window.__GUV_TAURI_TERMINAL_LOGGING_INSTALLED__ = true

  let api
  try {
    api = await import('@tauri-apps/plugin-log')
  } catch {
    return
  }

  const send = {
    log: api.info,
    info: api.info,
    warn: api.warn,
    error: api.error,
    debug: api.debug,
    trace: api.trace,
  }

  const originals = {
    log: console.log?.bind(console),
    info: console.info?.bind(console),
    warn: console.warn?.bind(console),
    error: console.error?.bind(console),
    debug: console.debug?.bind(console),
    trace: console.trace?.bind(console),
  }

  const wrap = (kind) => {
    const original = originals[kind]
    const fn = send[kind] || send.log

    console[kind] = (...args) => {
      try {
        original?.(...args)
      } finally {
        try {
          void fn(formatArgs(args))
        } catch {
          
        }
      }
    }
  }

  wrap('log')
  wrap('info')
  wrap('warn')
  wrap('error')
  wrap('debug')
  wrap('trace')
}

