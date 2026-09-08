import { createServer } from 'node:http'
import { chmod, mkdir } from 'node:fs/promises'

import { host, port, rootDir } from './config.mjs'
import { blobContentType, blobStat, parseRange, putBlob, readBlob, readBytes } from './cas.mjs'
import { applyOperations, getManifest } from './metadata.mjs'
import { backupSnapshot, getSnapshot, putSnapshot } from './snapshot.mjs'
import { createSession, requireMutationSecurity } from './security.mjs'

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  const data = await readBytes(req)
  try {
    return JSON.parse(data.toString('utf8'))
  } catch {
    throw Object.assign(new Error('invalid json'), { status: 400 })
  }
}

function blobHash(pathname) {
  const match = /^\/api\/(?:cas|blobs|persistence\/blobs)\/([^/]+)$/.exec(pathname)
  return match?.[1]
}

function matchesEtag(header, etag) {
  if (!header) return false
  return header.split(',').some((value) => {
    const tag = value.trim()
    return tag === '*' || tag.replace(/^W\//, '') === etag
  })
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true })
    if (req.method === 'GET' && ['/api/session', '/api/persistence/session'].includes(url.pathname)) return sendJson(res, 200, createSession(res))
    if (req.method === 'GET' && ['/api/persistence', '/api/sync'].includes(url.pathname)) return sendJson(res, 200, await getSnapshot())

    const hash = blobHash(url.pathname)
    if (hash && ['GET', 'HEAD'].includes(req.method)) {
      const info = await blobStat(hash)
      if (!info) return sendJson(res, 404, { error: 'not found' })
      const etag = '"' + hash + '"'
      if (matchesEtag(req.headers['if-none-match'], etag)) {
        res.writeHead(304, { etag })
        return res.end()
      }
      const range = parseRange(req.headers.range, info.size)
      if (!range) {
        res.writeHead(416, { 'content-range': 'bytes */' + info.size })
        return res.end()
      }
      const headers = {
        'accept-ranges': 'bytes',
        'cache-control': 'private, immutable',
        'content-length': String(range.end - range.start + 1),
        'content-type': await blobContentType(hash),
        etag,
      }
      if (range.partial) headers['content-range'] = 'bytes ' + range.start + '-' + range.end + '/' + info.size
      res.writeHead(range.partial ? 206 : 200, headers)
      if (req.method === 'HEAD') return res.end()
      return res.end(await readBlob(hash, range))
    }

    const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
    if (mutating && !requireMutationSecurity(req)) return sendJson(res, 403, { error: 'origin or csrf rejected' })
    if (hash && req.method === 'PUT') return sendJson(res, 201, await putBlob(req, hash))
    if (req.method === 'PUT' && ['/api/persistence', '/api/sync'].includes(url.pathname)) return sendJson(res, 200, await putSnapshot(await readJson(req)))
    if (req.method === 'POST' && ['/api/persistence/backup', '/api/backup'].includes(url.pathname)) return sendJson(res, 200, await backupSnapshot())

    if (req.method === 'GET' && ['/api/metadata', '/api/persistence/metadata'].includes(url.pathname)) {
      return sendJson(res, 200, await getManifest(url.searchParams.get('view') || url.searchParams.get('manifest') || 'active', url.searchParams.get('sinceRevision') ?? undefined))
    }
    if (['POST', 'PUT'].includes(req.method) && ['/api/metadata', '/api/metadata/operations', '/api/persistence/metadata'].includes(url.pathname)) {
      return sendJson(res, 200, await applyOperations(await readJson(req)))
    }
    return sendJson(res, 404, { error: 'not found' })
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500
    if (status === 500) console.error(error)
    return sendJson(res, status, { error: status === 500 ? 'request failed' : error instanceof Error ? error.message : 'request failed' })
  }
})

await mkdir(rootDir, { recursive: true, mode: 0o700 })
await chmod(rootDir, 0o700)
server.listen(port, host, () => console.log('persistence backend listening on ' + port))
