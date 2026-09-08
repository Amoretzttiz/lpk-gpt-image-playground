// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const children: ChildProcess[] = []
let dir = ''

async function start(port: number, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['server/persistence.mjs'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PERSISTENCE_DIR: join(dir, 'state'), ...env },
    stdio: 'ignore',
  })
  children.push(child)
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch('http://127.0.0.1:' + port + '/api/health')).ok) return
    } catch {
      // 等待启动
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('backend did not start')
}

async function stop() {
  const running = children.splice(0)
  for (const child of running) child.kill('SIGTERM')
  await Promise.all(running.map((child) => new Promise((resolve) => child.once('exit', resolve))))
}

async function session(base: string) {
  const response = await fetch(base + '/api/session')
  const body = await response.json() as { csrfToken: string }
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const setCookies = headers.getSetCookie?.() || [response.headers.get('set-cookie') || '']
  const cookie = setCookies.map((value) => value.split(';')[0]).join('; ')
  return {
    headers: { origin: base, cookie, 'x-csrf-token': body.csrfToken },
  }
}

async function mutate(base: string, auth: Awaited<ReturnType<typeof session>>, path: string, body: object) {
  const text = JSON.stringify(body)
  return fetch(base + path, {
    method: 'POST',
    headers: { ...auth.headers, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) },
    body: text,
  })
}

async function putSnapshot(base: string, auth: Awaited<ReturnType<typeof session>>, body: object) {
  const text = JSON.stringify(body)
  return fetch(base + '/api/persistence', {
    method: 'PUT',
    headers: { ...auth.headers, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) },
    body: text,
  })
}

afterEach(async () => {
  await stop()
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = ''
})

describe('v0.8 persistence backend', () => {
  it('starts empty in an isolated namespace without reading legacy state', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gpt-persistence-'))
    await mkdir(join(dir, 'state'), { recursive: true })
    const legacy = JSON.stringify({ tasks: [{ id: 'legacy' }] })
    await writeFile(join(dir, 'state', 'state.json'), legacy)
    const port = 19000 + Math.floor(Math.random() * 1000)
    await start(port)
    const response = await fetch('http://127.0.0.1:' + port + '/api/metadata?view=full')
    expect(await response.json()).toEqual({ revision: 0, entities: [], deletedIds: [] })
    expect(await readFile(join(dir, 'state', 'state.json'), 'utf8')).toBe(legacy)
  })

  it('requires same-origin double-submit CSRF for mutations', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gpt-persistence-'))
    const port = 20000 + Math.floor(Math.random() * 1000)
    await start(port)
    const base = 'http://127.0.0.1:' + port
    const body = JSON.stringify({ baseRevision: 0, operationId: 'create', operations: [] })
    expect((await fetch(base + '/api/metadata', { method: 'POST', body })).status).toBe(403)
    expect((await fetch(base + '/api/metadata', {
      method: 'POST',
      headers: { origin: base, 'x-csrf-token': '' },
      body,
    })).status).toBe(403)
    const auth = await session(base)
    expect((await fetch(base + '/api/metadata', {
      method: 'POST',
      headers: { ...auth.headers, origin: 'https://attacker.invalid', 'content-type': 'application/json' },
      body,
    })).status).toBe(403)
    expect((await fetch(base + '/api/metadata', {
      method: 'POST',
      headers: {
        ...auth.headers,
        origin: 'https://playground.example',
        'x-forwarded-host': 'playground.example',
        'x-forwarded-proto': 'https',
        'content-type': 'application/json',
      },
      body,
    })).status).toBe(400)
  })

  it('stores validated original bytes and serves HEAD, ETag, and byte ranges', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gpt-persistence-'))
    const port = 21000 + Math.floor(Math.random() * 1000)
    await start(port)
    const base = 'http://127.0.0.1:' + port
    const auth = await session(base)
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1])
    const hash = createHash('sha256').update(png).digest('hex')
    const uploaded = await fetch(base + '/api/blobs/' + hash, {
      method: 'PUT',
      headers: { ...auth.headers, 'content-type': 'image/png', 'content-length': String(png.length) },
      body: png,
    })
    expect(uploaded.status).toBe(201)
    const file = join(dir, 'state', 'v0.8', 'cas', hash.slice(0, 2), hash)
    expect(await readFile(file)).toEqual(png)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await stat(join(dir, 'state', 'v0.8'))).mode & 0o777).toBe(0o700)

    const head = await fetch(base + '/api/blobs/' + hash, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('etag')).toBe('"' + hash + '"')
    expect(head.headers.get('content-length')).toBe(String(png.length))
    expect((await fetch(base + '/api/blobs/' + hash, { headers: { 'if-none-match': '"other", W/"' + hash + '"' } })).status).toBe(304)
    expect((await fetch(base + '/api/blobs/' + hash, { headers: { 'if-none-match': '*' } })).status).toBe(304)
    expect((await fetch(base + '/api/blobs/' + hash, { headers: { 'if-none-match': '"other", "missing"' } })).status).toBe(200)
    const range = await fetch(base + '/api/blobs/' + hash, { headers: { range: 'bytes=1-3' } })
    expect(range.status).toBe(206)
    expect(Buffer.from(await range.arrayBuffer())).toEqual(png.subarray(1, 4))
    expect(range.headers.get('content-range')).toBe('bytes 1-3/' + png.length)
    expect((await fetch(base + '/api/blobs/' + hash, { headers: { range: 'bytes=999-' } })).status).toBe(416)

    const badHash = '0'.repeat(64)
    expect((await fetch(base + '/api/blobs/' + badHash, {
      method: 'PUT',
      headers: { ...auth.headers, 'content-type': 'image/png', 'content-length': String(png.length) },
      body: png,
    })).status).toBe(422)
    expect((await fetch(base + '/api/blobs/' + hash, {
      method: 'PUT',
      headers: { ...auth.headers, 'content-type': 'image/jpeg', 'content-length': String(png.length) },
      body: png,
    })).status).toBe(415)
  })

  it('applies revisioned idempotent metadata and never revives deleted ids', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gpt-persistence-'))
    const port = 22000 + Math.floor(Math.random() * 1000)
    await start(port)
    const base = 'http://127.0.0.1:' + port
    const auth = await session(base)
    const create = {
      baseRevision: 0,
      operationId: 'op-create',
      operations: [{ type: 'create', id: 'image-1', entityType: 'image', expectedEntityRevision: 0, value: { title: 'first' } }],
    }
    const created = await mutate(base, auth, '/api/metadata/operations', create)
    expect(created.status).toBe(200)
    expect(await created.json()).toEqual({ operationId: 'op-create', revision: 1 })
    const replayed = await mutate(base, auth, '/api/metadata/operations', create)
    expect(await replayed.json()).toEqual({ operationId: 'op-create', revision: 1 })

    const conflict = await mutate(base, auth, '/api/metadata/operations', {
      baseRevision: 1,
      operationId: 'op-conflict',
      operations: [{ type: 'update', id: 'image-1', expectedEntityRevision: 0, value: { title: 'bad' } }],
    })
    expect(conflict.status).toBe(409)
    const updated = await mutate(base, auth, '/api/metadata/operations', {
      baseRevision: 1,
      operationId: 'op-update',
      operations: [{ type: 'update', id: 'image-1', expectedEntityRevision: 1, value: { title: 'second' } }],
    })
    expect((await updated.json()).revision).toBe(2)
    const removed = await mutate(base, auth, '/api/metadata/operations', {
      baseRevision: 2,
      operationId: 'op-delete',
      operations: [{ type: 'delete', id: 'image-1', expectedEntityRevision: 2 }],
    })
    expect((await removed.json()).revision).toBe(3)

    const active = await (await fetch(base + '/api/metadata?view=active')).json() as { entities: unknown[] }
    expect(active.entities).toEqual([])
    const full = await (await fetch(base + '/api/metadata?view=full')).json() as { deletedIds: string[] }
    expect(full.deletedIds).toEqual(['image-1'])
    const delta = await (await fetch(base + '/api/metadata?sinceRevision=2')).json() as { baseRevision: number, revision: number, deletedIds: string[] }
    expect(delta).toEqual({ baseRevision: 2, revision: 3, entities: [], deletedIds: ['image-1'] })

    const revive = await mutate(base, auth, '/api/metadata/operations', {
      baseRevision: 3,
      operationId: 'op-revive',
      operations: [{ type: 'create', id: 'image-1', entityType: 'image', expectedEntityRevision: 0, value: {} }],
    })
    expect(revive.status).toBe(409)
    expect((await stat(join(dir, 'state', 'v0.8', 'metadata.json'))).mode & 0o777).toBe(0o600)
  })

  it('serializes metadata transactions across two backend processes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gpt-persistence-'))
    const firstPort = 23000 + Math.floor(Math.random() * 500)
    const secondPort = firstPort + 500
    await Promise.all([start(firstPort), start(secondPort)])
    const firstBase = 'http://127.0.0.1:' + firstPort
    const secondBase = 'http://127.0.0.1:' + secondPort
    const [firstAuth, secondAuth] = await Promise.all([session(firstBase), session(secondBase)])
    const [first, second] = await Promise.all([
      mutate(firstBase, firstAuth, '/api/metadata/operations', {
        baseRevision: 0,
        operationId: 'process-one',
        operations: [{ type: 'create', id: 'from-one', entityType: 'image', expectedEntityRevision: 0, value: {} }],
      }),
      mutate(secondBase, secondAuth, '/api/metadata/operations', {
        baseRevision: 0,
        operationId: 'process-two',
        operations: [{ type: 'create', id: 'from-two', entityType: 'image', expectedEntityRevision: 0, value: {} }],
      }),
    ])
    expect([first.status, second.status].sort()).toEqual([200, 409])
    const manifest = await (await fetch(firstBase + '/api/metadata')).json() as { revision: number, entities: { id: string }[] }
    expect(manifest.revision).toBe(1)
    expect(manifest.entities).toHaveLength(1)
    expect(['from-one', 'from-two']).toContain(manifest.entities[0].id)
    const stored = JSON.parse(await readFile(join(dir, 'state', 'v0.8', 'metadata.json'), 'utf8'))
    expect(Object.keys(stored.entities)).toHaveLength(1)
    expect(Object.keys(stored.operationIds)).toHaveLength(1)
  })

  it('executes and replays prototype-key operations without polluting dictionaries', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gpt-persistence-'))
    const port = 24000 + Math.floor(Math.random() * 500)
    await start(port)
    const base = 'http://127.0.0.1:' + port
    const auth = await session(base)
    const firstBody = {
      baseRevision: 0,
      operationId: 'toString',
      operations: [{
        type: 'create',
        id: '__proto__',
        entityType: 'image',
        expectedEntityRevision: 0,
        value: JSON.parse('{"title":"safe","__proto__":{"polluted":true}}'),
      }],
    }
    const first = await mutate(base, auth, '/api/metadata/operations', firstBody)
    expect(await first.json()).toEqual({ operationId: 'toString', revision: 1 })
    expect(await (await mutate(base, auth, '/api/metadata/operations', firstBody)).json()).toEqual({ operationId: 'toString', revision: 1 })

    const secondBody = {
      baseRevision: 1,
      operationId: '__proto__',
      operations: [{ type: 'create', id: 'constructor', entityType: 'image', expectedEntityRevision: 0, value: {} }],
    }
    expect(await (await mutate(base, auth, '/api/metadata/operations', secondBody)).json()).toEqual({ operationId: '__proto__', revision: 2 })
    expect(await (await mutate(base, auth, '/api/metadata/operations', secondBody)).json()).toEqual({ operationId: '__proto__', revision: 2 })
    const removed = await mutate(base, auth, '/api/metadata/operations', {
      baseRevision: 2,
      operationId: 'constructor',
      operations: [{ type: 'delete', id: '__proto__', expectedEntityRevision: 1 }],
    })
    expect(await removed.json()).toEqual({ operationId: 'constructor', revision: 3 })

    const full = await (await fetch(base + '/api/metadata?view=full')).json() as { revision: number, entities: { id: string }[], deletedIds: string[] }
    expect(full).toEqual({
      revision: 3,
      entities: [{ id: 'constructor', entityType: 'image', entityRevision: 1 }],
      deletedIds: ['__proto__'],
    })
    const stored = JSON.parse(await readFile(join(dir, 'state', 'v0.8', 'metadata.json'), 'utf8'))
    expect(Object.hasOwn(stored.operationIds, 'toString')).toBe(true)
    expect(Object.hasOwn(stored.operationIds, '__proto__')).toBe(true)
    expect(Object.hasOwn(stored.entities, 'constructor')).toBe(true)
    expect(Object.hasOwn(stored.deletedIds, '__proto__')).toBe(true)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it('expires sessions, enforces the hard cap, and hides internal errors', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gpt-persistence-'))
    const port = 25000 + Math.floor(Math.random() * 500)
    await start(port, { MAX_SESSIONS: '1', SESSION_TTL_MS: '80' })
    const base = 'http://127.0.0.1:' + port
    const first = await session(base)
    const second = await session(base)
    const body = { baseRevision: 0, operationId: 'session-check', operations: [] }
    expect((await mutate(base, first, '/api/metadata/operations', body)).status).toBe(403)
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect((await mutate(base, second, '/api/metadata/operations', body)).status).toBe(403)

    await mkdir(join(dir, 'state', 'v0.8'), { recursive: true })
    await writeFile(join(dir, 'state', 'v0.8', 'metadata.json'), '{private parse detail')
    const response = await fetch(base + '/api/metadata')
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'request failed' })
  })

  it('merges snapshot writes across processes and rejects malformed snapshots', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gpt-persistence-'))
    const firstPort = 26000 + Math.floor(Math.random() * 300)
    const secondPort = firstPort + 300
    await Promise.all([start(firstPort), start(secondPort)])
    const firstBase = 'http://127.0.0.1:' + firstPort
    const secondBase = 'http://127.0.0.1:' + secondPort
    const [firstAuth, secondAuth] = await Promise.all([session(firstBase), session(secondBase)])
    const baseSnapshot = { version: 2, updatedAt: 1, images: [], thumbnails: [], agentConversations: [], settings: {}, persistedState: null }
    const [first, second] = await Promise.all([
      putSnapshot(firstBase, firstAuth, { ...baseSnapshot, tasks: [{ id: 'from-one' }] }),
      putSnapshot(secondBase, secondAuth, { ...baseSnapshot, tasks: [{ id: 'from-two' }] }),
    ])
    expect([first.status, second.status]).toEqual([200, 200])
    const stored = await (await fetch(firstBase + '/api/persistence')).json() as { tasks: { id: string }[] }
    expect(stored.tasks.map((task) => task.id).sort()).toEqual(['from-one', 'from-two'])
    expect((await putSnapshot(firstBase, firstAuth, null as unknown as object)).status).toBe(400)
    expect((await putSnapshot(firstBase, firstAuth, { ...baseSnapshot, tasks: [{ id: '' }] })).status).toBe(400)
  })

  it('writes redacted private backups and preserves the root snapshot after restart', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gpt-persistence-'))
    const port = 27000 + Math.floor(Math.random() * 300)
    await start(port)
    const base = 'http://127.0.0.1:' + port
    const auth = await session(base)
    const snapshot = {
      version: 2,
      updatedAt: 1,
      tasks: [{ id: 'persistent', prompt: 'kept across restart' }],
      images: [],
      thumbnails: [],
      agentConversations: [],
      settings: { apiKey: 'private-key', nested: { accessToken: 'private-token', label: 'kept' } },
      persistedState: null,
    }
    expect((await putSnapshot(base, auth, snapshot)).status).toBe(200)
    expect((await mutate(base, auth, '/api/persistence/backup', {})).status).toBe(200)
    const backup = JSON.parse(await readFile(join(dir, 'state', 'backups', 'latest.json'), 'utf8'))
    expect(backup.settings).toEqual({ apiKey: '[REDACTED]', nested: { accessToken: '[REDACTED]', label: 'kept' } })
    const stateStat = await stat(join(dir, 'state', 'state.json'))
    expect(stateStat.mode & 0o777).toBe(0o600)
    await stop()
    await start(port)
    const restored = await (await fetch(base + '/api/persistence')).json() as { tasks: { id: string }[] }
    expect(restored.tasks).toContainEqual({ id: 'persistent', prompt: 'kept across restart' })
  })

})
