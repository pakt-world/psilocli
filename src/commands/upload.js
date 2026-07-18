import { readFile } from 'fs/promises'
import { resolve, basename, extname } from 'path'
import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { out, print, note, fail, cliTable } from '../output.js'

export const usage =
  'psilocli upload <path> [--private] [--type <mime>]\n' +
  '       psilocli upload list [--page <n>] [--limit <n>] [--name <s>]\n' +
  '       psilocli upload get <id>\n' +
  '       psilocli upload url <id>'

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/jpg',
  'image/svg',
  'image/svg+xml',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
  'video/mp4',
  'video/x-msvideo',
  'audio/mpeg',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
])

const EXT_MIME_MAP = {
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.pdf':  'application/pdf',
  '.mp4':  'video/mp4',
  '.avi':  'video/x-msvideo',
  '.mp3':  'audio/mpeg',
  '.txt':  'text/plain',
  '.csv':  'text/csv',
  '.doc':  'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls':  'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

function detectMime(filePath) {
  return EXT_MIME_MAP[extname(filePath).toLowerCase()] ?? null
}

async function runUploadFile(argv) {
  const { values, positionals } = parseCommand(
    argv,
    {
      private: { type: 'boolean' },
      type:    { type: 'string' },
    },
    { positionals: true },
  )

  const filePath = positionals[0]
  if (!filePath) fail(`Usage: ${usage}`, 2)

  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)

  const absPath  = resolve(filePath)
  const filename = basename(absPath)
  const mimetype = values.type ?? detectMime(absPath)

  if (!mimetype) {
    fail(
      `Cannot detect MIME type for "${filename}". Use --type to specify one.\n` +
      `Allowed: ${[...ALLOWED_MIME_TYPES].join(', ')}`,
      2,
    )
  }
  if (!ALLOWED_MIME_TYPES.has(mimetype)) {
    fail(
      `MIME type "${mimetype}" is not allowed.\n` +
      `Allowed: ${[...ALLOWED_MIME_TYPES].join(', ')}`,
      2,
    )
  }

  note(`Reading ${absPath}…`)
  const buffer = await readFile(absPath)

  note(`Uploading ${filename} (${mimetype}, ${buffer.length} bytes)…`)
  const method = values.private ? 'uploadPrivate' : 'upload'
  const result = sdkOk(await sdk.upload[method](buffer, filename, mimetype), 'upload')

  if (config.json) {
    out(result)
  } else {
    cliTable(
      [[
        String(result._id).slice(-12),
        result.name ?? filename,
        String(result.status),
        result.url ?? '',
        result.createdAt ? new Date(result.createdAt).toISOString().slice(0, 10) : '',
      ]],
      ['ID', 'Name', 'Status', 'URL', 'Date'],
    )
  }
}

async function runList(argv) {
  const { values } = parseCommand(argv, {
    page:  { type: 'string' },
    limit: { type: 'string' },
    name:  { type: 'string' },
  })

  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)

  const filter = {}
  if (values.page)  filter.page  = values.page
  if (values.limit) filter.limit = values.limit
  if (values.name)  filter.name  = values.name

  const result = sdkOk(await sdk.upload.getUploads(filter), 'upload list')
  const files  = result?.data ?? (Array.isArray(result) ? result : [])

  if (config.json) {
    out(result)
  } else if (files.length === 0) {
    print('No uploads found.')
  } else {
    cliTable(
      files.map((f) => [
        String(f._id).slice(-12),
        (f.name ?? '').slice(0, 40),
        f.url ? f.url.slice(0, 50) : '',
        f.createdAt ? new Date(f.createdAt).toISOString().slice(0, 10) : '',
      ]),
      ['ID', 'Name', 'URL', 'Date'],
    )
  }
}

async function runGet(argv) {
  const { values, positionals } = parseCommand(argv, {}, { positionals: true })

  const id = positionals[0]
  if (!id) fail(`Usage: psilocli upload get <id>`, 2)

  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)

  const result = sdkOk(await sdk.upload.getUpload(id), 'upload get')

  if (config.json) {
    out(result)
  } else {
    cliTable(
      [[
        String(result._id).slice(-12),
        result.name ?? '',
        String(result.status),
        result.url ?? '',
        result.createdAt ? new Date(result.createdAt).toISOString().slice(0, 10) : '',
      ]],
      ['ID', 'Name', 'Status', 'URL', 'Date'],
    )
  }
}

async function runUrl(argv) {
  const { values, positionals } = parseCommand(argv, {}, { positionals: true })

  const id = positionals[0]
  if (!id) fail(`Usage: psilocli upload url <id>`, 2)

  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)

  const result = sdkOk(await sdk.upload.getPresignedUrl(id), 'upload url')

  if (config.json) {
    out(result)
  } else {
    print(result.url)
  }
}

export async function run(argv) {
  const sub = argv[0]

  const SUBS = { list: runList, get: runGet, url: runUrl }

  if (sub && SUBS[sub]) {
    return SUBS[sub](argv.slice(1))
  }

  // Anything else (a file path, relative or absolute) → file upload
  return runUploadFile(argv)
}
