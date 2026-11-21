import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat, realpath } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { downloadKey, site } from './site-release.mjs'

export async function serve(artifacts, mime) {
  const downloads = new Map()
  for (const { version, path, file } of artifacts) {
    const key = downloadKey(version, file)
    downloads.set(key, path)
    downloads.set(key + '.sha256', path + '.sha256')
  }
  const server = createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405).end()
        return
      }
      const url = new URL(req.url, 'http://localhost')
      const key = decodeURIComponent(url.pathname.slice(1)) || 'index.html'
      if (key.split(/[\\/]/).some((part) => part.startsWith('.'))) {
        res.writeHead(404).end()
        return
      }
      let path = downloads.get(key)
      if (!path) {
        path = await realpath(join(site, key))
        if (relative(site, path).split(sep)[0] === '..') {
          res.writeHead(404).end()
          return
        }
      }
      const info = await stat(path)
      if (!info.isFile()) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, {
        'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': 'no-store',
      })
      if (req.method === 'HEAD') res.end()
      else await pipeline(createReadStream(path), res)
    } catch {
      if (!res.headersSent) res.writeHead(404)
      res.end()
    }
  })
  server.listen(Number(process.env.PORT ?? 4173), '127.0.0.1', () => {
    console.log('本地官网 http://127.0.0.1:' + server.address().port + '/')
  })
}
