import { readFile } from 'node:fs/promises'

import { backupDir, snapshotFile, snapshotLockFile } from './config.mjs'
import { atomicJson, withFileLock } from './fsAtomic.mjs'

function emptySnapshot() {
  return {
    version: 2,
    updatedAt: 0,
    tasks: [],
    images: [],
    thumbnails: [],
    agentConversations: [],
    settings: {},
    persistedState: null,
  }
}

function validateSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 2) throw Object.assign(new Error('invalid persistence snapshot'), { status: 400 })
  for (const key of ['tasks', 'images', 'thumbnails', 'agentConversations']) {
    if (!Array.isArray(value[key])) throw Object.assign(new Error('invalid persistence snapshot'), { status: 400 })
  }
  if (!value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings)) throw Object.assign(new Error('invalid persistence snapshot'), { status: 400 })
  return value
}

async function loadSnapshot() {
  try {
    return validateSnapshot(JSON.parse(await readFile(snapshotFile, 'utf8')))
  } catch (error) {
    if (error.code === 'ENOENT') return emptySnapshot()
    throw error
  }
}

function mergeById(current, incoming) {
  const merged = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) {
    if (!item || typeof item.id !== 'string' || !item.id) throw Object.assign(new Error('invalid persistence entity'), { status: 400 })
    merged.set(item.id, item)
  }
  return [...merged.values()]
}

export async function getSnapshot() {
  return loadSnapshot()
}

export async function putSnapshot(value) {
  const incoming = validateSnapshot(value)
  return withFileLock(snapshotLockFile, async () => {
    const current = await loadSnapshot()
    const next = {
      ...current,
      ...incoming,
      version: 2,
      updatedAt: Date.now(),
      tasks: mergeById(current.tasks, incoming.tasks),
      images: mergeById(current.images, incoming.images),
      thumbnails: mergeById(current.thumbnails, incoming.thumbnails),
      agentConversations: mergeById(current.agentConversations, incoming.agentConversations),
    }
    await atomicJson(snapshotFile, next)
    return next
  })
}

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    /api[-_ ]?key|access[-_ ]?token|secret|authorization/i.test(key)
      ? [key, '[REDACTED]']
      : [key, redactSecrets(item)],
  ))
}

export async function backupSnapshot() {
  return withFileLock(snapshotLockFile, async () => {
    const snapshot = redactSecrets(await loadSnapshot())
    await atomicJson(backupDir + '/backup.json', snapshot)
    await atomicJson(backupDir + '/latest.json', snapshot)
    return { ok: true }
  })
}
