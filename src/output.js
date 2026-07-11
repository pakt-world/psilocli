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
  process.stdout.write(fmt(headers) + '\n')
  process.stdout.write(widths.map((w) => '-'.repeat(w)).join('  ') + '\n')
  for (const row of rows) process.stdout.write(fmt(row) + '\n')
}

export function configureJsonMode() {
  console.log = console.error
}
