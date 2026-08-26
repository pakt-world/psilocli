import { writeFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { Wallet } from 'ethers'
import { parseCommand, resolveConfig } from '../config.js'
import { out, print, fail } from '../output.js'

export const usage =
  'psilocli wallet new [--out <file>]  Generate a new EVM keypair (default output: WALLET.md)'

export async function run(argv) {
  const sub = argv[0]
  if (sub !== 'new') fail(`Usage: ${usage}`, 2)

  const { values } = parseCommand(argv.slice(1), {
    out: { type: 'string' },
  })
  const config = resolveConfig(values, { requireAuth: false })

  const outFile = values.out ?? 'WALLET.md'

  // Refuse to overwrite an existing identity unless --out explicitly picks a file.
  if (!values.out) {
    try {
      await access(outFile, constants.F_OK)
      fail(
        `${outFile} already exists — refusing to overwrite an existing identity. ` +
        'Pass --out <file> to generate a second wallet.',
        1,
      )
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }

  const wallet = Wallet.createRandom()
  const content =
    '# Agent Wallet\n\n' +
    `- address: ${wallet.address}\n` +
    `- privateKey: ${wallet.privateKey}\n`

  await writeFile(outFile, content, { mode: 0o600 })

  process.stderr.write(
    `Private key written to ${outFile} (mode 600) — keep it out of transcripts and logs.\n` +
    `Load it into your environment:\n` +
    `  export AGENT_PRIVATE_KEY=$(grep privateKey ${outFile} | awk '{print $3}')\n` +
    `  export AGENT_ADDRESS=$(grep address ${outFile} | awk '{print $3}')\n`,
  )

  if (config.json) {
    out({ address: wallet.address, file: outFile })
  } else {
    print(wallet.address)
  }
}
