const C = {
  reset:  '\x1b[0m',
  gray:   '\x1b[90m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  blue:   '\x1b[34m',
  magenta:'\x1b[35m',
  red:    '\x1b[31m',
  orange: '\x1b[38;5;208m',
  lime:   '\x1b[92m',
  bold:   '\x1b[1m',
}

const TAG_COLOR = {
  Auth:      C.yellow,
  OpenSky:   C.cyan,
  Routes:    C.blue,
  FIRMS:     C.green,
  Firestore: C.magenta,
  Airports:  C.lime,
  Socket:    C.orange,
}

function log(tag, msg, level = 'info') {
  const ts  = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const col = TAG_COLOR[tag] || C.reset
  const lvl = level === 'warn'  ? `${C.yellow}WARN${C.reset} ` :
              level === 'error' ? `${C.red}ERR ${C.reset} ` : ''
  process.stdout.write(`${C.gray}${ts}${C.reset} ${col}[${tag}]${C.reset} ${lvl}${msg}\n`)
}

module.exports = { log }
