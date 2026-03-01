import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const workspaceRoot = path.resolve(__dirname, '..')
const nsisDir = path.join(
  workspaceRoot,
  'src-tauri',
  'target',
  'release',
  'bundle',
  'nsis',
)
const configPath = path.join(workspaceRoot, 'src-tauri', 'tauri.conf.json')
const port = 1420

function readConfigVersion() {
  const raw = fs.readFileSync(configPath, 'utf-8')
  const json = JSON.parse(raw)
  return json.version ?? '0.0.0'
}

function semverToTuple(version) {
  return version
    .replace(/^v/, '')
    .split('.')
    .map((value) => Number(value || 0))
}

function isVersionGreater(a, b) {
  const [a1 = 0, a2 = 0, a3 = 0] = semverToTuple(a)
  const [b1 = 0, b2 = 0, b3 = 0] = semverToTuple(b)
  if (a1 !== b1) return a1 > b1
  if (a2 !== b2) return a2 > b2
  return a3 > b3
}

function resolveLatestBundle() {
  if (!fs.existsSync(nsisDir)) {
    throw new Error('Bundle NSIS não encontrado. Rode o tauri:build antes.')
  }

  const entries = fs.readdirSync(nsisDir)
  const candidates = entries
    .filter((file) => file.endsWith('-setup.exe') || file.endsWith('.nsis.zip'))
    .map((file) => {
      const filePath = path.join(nsisDir, file)
      const signaturePath = path.join(nsisDir, `${file}.sig`)
      return {
        file,
        filePath,
        signaturePath,
        hasSignature: fs.existsSync(signaturePath),
        mtime: fs.statSync(filePath).mtimeMs,
        isExe: file.endsWith('-setup.exe'),
      }
    })
    .filter((file) => file.hasSignature)
    .sort((a, b) => {
      if (a.isExe !== b.isExe) return a.isExe ? -1 : 1
      return b.mtime - a.mtime
    })

  if (!candidates.length) {
    throw new Error('Nenhum instalador com assinatura encontrado em src-tauri/target/release/bundle/nsis')
  }

  const installer = candidates[0].file
  const signaturePath = candidates[0].signaturePath

  return {
    installer,
    installerPath: path.join(nsisDir, installer),
    signature: fs.readFileSync(signaturePath, 'utf-8').trim(),
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body, null, 2))
}

const server = http.createServer((req, res) => {
  try {
    if (!req.url) {
      res.writeHead(400)
      res.end('Bad request')
      return
    }

    const url = new URL(req.url, `http://localhost:${port}`)
    const segments = url.pathname.split('/').filter(Boolean)

    if (segments[0] === 'downloads') {
      const filename = segments.slice(1).join('/')
      const filePath = path.join(nsisDir, filename)
      if (!fs.existsSync(filePath)) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      fs.createReadStream(filePath).pipe(res)
      return
    }

    if (segments[0] === 'updates') {
      const target = segments[1]
      const arch = segments[2]
      const currentVersion = segments[3] ?? '0.0.0'

      if (target !== 'windows' || arch !== 'x86_64') {
        res.writeHead(204)
        res.end()
        return
      }

      const latestVersion = readConfigVersion()
      if (!isVersionGreater(latestVersion, currentVersion)) {
        res.writeHead(204)
        res.end()
        return
      }

      const bundle = resolveLatestBundle()
      const payload = {
        version: latestVersion,
        notes: 'Atualização local de desenvolvimento.',
        pub_date: new Date().toISOString(),
        url: `http://localhost:${port}/downloads/${bundle.installer}`,
        signature: bundle.signature,
      }

      sendJson(res, 200, payload)
      return
    }

    res.writeHead(404)
    res.end('Not found')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro desconhecido.'
    sendJson(res, 500, { error: message })
  }
})

server.listen(port, () => {
  console.log(`Updater local rodando em http://localhost:${port}`)
})
