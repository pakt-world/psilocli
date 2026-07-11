import { out, cliTable } from '../output.js'

export async function cmdWhoami(config, { userId }) {
  const data = { name: config.name, address: config.address, userId }
  if (config.json) {
    out(data)
  } else {
    process.stdout.write(`Name:    ${data.name}\n`)
    process.stdout.write(`Address: ${data.address}\n`)
    process.stdout.write(`User ID: ${data.userId}\n`)
  }
}
