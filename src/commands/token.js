import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, decodeUserId } from '../client.js'
import { out, print } from '../output.js'

export const usage =
  'psilocli token  Authenticate (SIWA) and print a live JWT\n' +
  '  --json outputs { "address", "userId", "jwt" } — pipe to PROOF.json:\n' +
  '    psilocli token --json > PROOF.json'

export async function run(argv) {
  const { values } = parseCommand(argv, {})
  const config = resolveConfig(values)
  const { jwt } = await cliInit(config)
  const userId = decodeUserId(jwt)

  if (config.json) {
    out({ address: config.address, userId, jwt })
  } else {
    print(`address: ${config.address}`)
    print(`userId:  ${userId}`)
    print(`jwt:     ${jwt.slice(0, 40)}…`)
  }
}
