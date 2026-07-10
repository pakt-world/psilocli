// stdout is reserved for command output (tables or --json); progress and
// diagnostics go to stderr via note()/fail() so JSON output stays parseable.

export function print(...args) {
  console.log(...args)
}

export function note(msg) {
  process.stderr.write(`${msg}\n`)
}

export function out(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n')
}

export function fail(msg, code = 1) {
  process.stderr.write(`Error: ${msg}\n`)
  process.exit(code)
}

export function cliTable(rows, headers) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)),
  )
  const fmt = (cells) =>
    cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ')
  print(fmt(headers))
  print(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const row of rows) print(fmt(row))
}
