import type { AgentConversation, AppSettings, StoredImage, StoredImageThumbnail, TaskRecord } from '../types'
import { getAllAgentConversations, getAllImages, getAllImageThumbnails, getAllTasks, putAgentConversation, putImage, putImageThumbnail, putTask } from './db'
import { getPersistedState, useStore } from '../store'

export interface PersistenceSnapshot {
  version: 2
  updatedAt: number
  tasks: TaskRecord[]
  images: StoredImage[]
  thumbnails: StoredImageThumbnail[]
  agentConversations: AgentConversation[]
  settings: AppSettings
  persistedState: unknown
}

// Empty means same-origin; LazyCat nginx proxies /api/persistence.
const endpoint = (import.meta.env.VITE_PERSISTENCE_URL as string | undefined)?.replace(/\/$/, '') ?? ''
let syncTimer: ReturnType<typeof setTimeout> | undefined
let syncStarted = false
let syncing = false
let queued = false
let csrfToken: string | undefined
let csrfRequest: Promise<string> | undefined

async function getCsrfToken() {
  if (csrfToken) return csrfToken
  if (!csrfRequest) {
    csrfRequest = fetch(`${endpoint}/api/persistence/session`, { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`persistence session failed: ${response.status}`)
        const body = await response.json() as { csrfToken?: unknown }
        if (typeof body.csrfToken !== 'string' || !body.csrfToken) throw new Error('persistence session returned no CSRF token')
        csrfToken = body.csrfToken
        return body.csrfToken
      })
      .finally(() => { csrfRequest = undefined })
  }
  return csrfRequest
}

async function request<T>(path: string, init: RequestInit = {}, canRetry = true): Promise<T> {
  const mutating = init.method && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(init.method.toUpperCase())
  const headers = new Headers(init.headers)
  if (mutating) headers.set('x-csrf-token', await getCsrfToken())
  const response = await fetch(`${endpoint}${path}`, { ...init, headers, credentials: 'same-origin' })
  if (response.status === 403 && mutating && canRetry) {
    csrfToken = undefined
    return request<T>(path, init, false)
  }
  if (!response.ok) throw new Error(`persistence request failed: ${response.status}`)
  return response.json() as Promise<T>
}

export async function exportPersistenceSnapshot(): Promise<PersistenceSnapshot> {
  const state = useStore.getState()
  const [tasks, images, thumbnails, agentConversations] = await Promise.all([
    getAllTasks(), getAllImages(), getAllImageThumbnails(), getAllAgentConversations(),
  ])
  return { version: 2, updatedAt: Date.now(), tasks, images, thumbnails, agentConversations, settings: state.settings, persistedState: getPersistedState(state) }
}

export async function pullPersistence(signal?: AbortSignal) { return request<PersistenceSnapshot>('/api/persistence', { signal }) }
export async function pushPersistence(snapshot: PersistenceSnapshot, signal?: AbortSignal) {
  await request<PersistenceSnapshot>('/api/persistence', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot), signal })
  return true
}
export async function requestPersistenceBackup(signal?: AbortSignal) {
  await request<{ ok: boolean }>('/api/persistence/backup', { method: 'POST', signal })
  return true
}

function nonEmpty(snapshot: PersistenceSnapshot) { return snapshot.tasks.length > 0 || snapshot.images.length > 0 || snapshot.agentConversations.length > 0 }

function mergeById<T extends { id: string }>(local: T[], remote: T[]) {
  const merged = new Map(remote.map((item) => [item.id, item]))
  for (const item of local) merged.set(item.id, item)
  return [...merged.values()]
}

/** 首次同步只追加远端缺失记录；本地永远不因后端空/失败而被删除。 */
export async function reconcilePersistence() {
  try {
    const remote = await pullPersistence()
    if (!remote) return
    const local = await exportPersistenceSnapshot()
    const tasks = mergeById(local.tasks, remote.tasks ?? [])
    const images = mergeById(local.images, remote.images ?? [])
    const thumbnails = mergeById(local.thumbnails, remote.thumbnails ?? [])
    const agentConversations = mergeById(local.agentConversations, remote.agentConversations ?? [])
    await Promise.all(tasks.map(putTask))
    await Promise.all(images.map(putImage))
    await Promise.all(thumbnails.map(putImageThumbnail))
    await Promise.all(agentConversations.map(putAgentConversation))
    useStore.setState({ tasks, agentConversations })
    if (!nonEmpty(local) && remote.updatedAt > 0 && remote.settings) useStore.getState().setSettings(remote.settings)
    await pushPersistence(await exportPersistenceSnapshot())
  } catch (error) { console.warn('Persistence unavailable; continuing offline', error) }
}

async function flush() {
  if (syncing) { queued = true; return }
  syncing = true
  try { do { queued = false; await pushPersistence(await exportPersistenceSnapshot()) } while (queued) }
  catch (error) { console.warn('Persistence sync failed; local data is safe', error) }
  finally { syncing = false }
}

export function startPersistenceSync() {
  if (syncStarted) return
  syncStarted = true
  void reconcilePersistence()
  useStore.subscribe(() => {
    if (syncTimer) clearTimeout(syncTimer)
    syncTimer = setTimeout(() => { syncTimer = undefined; void flush() }, 750)
  })
}
export function getPersistenceEndpoint() { return endpoint }
