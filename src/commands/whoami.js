import { parseCommand, resolveConfig } from '../config.js'
import { cliInit } from '../client.js'
import { out, print } from '../output.js'

export const usage = 'psilocli whoami'

export async function run(argv) {
  const { values } = parseCommand(argv)
  const config = resolveConfig(values)
  const { userId } = await cliInit(config)
  const data = { name: config.name, address: config.address, userId }
  if (config.json) {
    out(data)
  } else {
    print(`Name:    ${data.name}`)
    print(`Address: ${data.address}`)
    print(`User ID: ${data.userId}`)
  }
}
