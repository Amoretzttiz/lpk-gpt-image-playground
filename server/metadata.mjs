import { readFile } from 'node:fs/promises'

import { metadataFile, metadataLockFile } from './config.mjs'
import { atomicJson, withFileLock } from './fsAtomic.mjs'

let pending = Promise.resolve()

function dictionary(value) {
  const result = Object.create(null)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [key, entry] of Object.entries(value)) result[key] = entry
  return result
}

function emptyState() {
  return { version: 1, revision: 0, entities: dictionary(), deletedIds: dictionary(), operationIds: dictionary() }
}

function normalizeState(value) {
  if (!value || value.version !== 1) return emptyState()
  return {
    version: 1,
    revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
    entities: dictionary(value.entities),
    deletedIds: dictionary(value.deletedIds),
    operationIds: dictionary(value.operationIds),
  }
}

async function load() {
  try {
    return normalizeState(JSON.parse(await readFile(metadataFile, 'utf8')))
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState()
    throw error
  }
}

function publicEntity(entity) {
  const { updatedRevision, ...value } = entity
  return value
}

export async function getManifest(view = 'active', sinceRevision) {
  const state = await load()
  if (sinceRevision !== undefined) {
    const since = Number(sinceRevision)
    if (!Number.isSafeInteger(since) || since < 0 || since > state.revision) throw Object.assign(new Error('invalid revision'), { status: 400 })
    return {
      baseRevision: since,
      revision: state.revision,
      entities: Object.values(state.entities).filter((entity) => entity.updatedRevision > since).map(publicEntity),
      deletedIds: Object.entries(state.deletedIds).filter(([, revision]) => revision > since).map(([id]) => id),
    }
  }
  const result = { revision: state.revision, entities: Object.values(state.entities).map(publicEntity) }
  if (view === 'active') return result
  if (view === 'full') return { ...result, deletedIds: Object.keys(state.deletedIds) }
  throw Object.assign(new Error('invalid manifest view'), { status: 400 })
}

function validateOperation(op, state, revision) {
  if (!op || !['create', 'update', 'delete'].includes(op.type)) throw Object.assign(new Error('invalid operation'), { status: 400 })
  const value = op.entity || op.value || {}
  const id = op.id || value.id
  if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(id)) throw Object.assign(new Error('invalid entity id'), { status: 400 })
  const current = Object.hasOwn(state.entities, id) ? state.entities[id] : undefined
  if (!Number.isSafeInteger(op.expectedEntityRevision) || op.expectedEntityRevision < 0) throw Object.assign(new Error('expected entity revision required'), { status: 400 })
  if (op.type === 'create') {
    if (op.expectedEntityRevision !== 0 || current || Object.hasOwn(state.deletedIds, id)) throw Object.assign(new Error('entity conflict'), { status: 409 })
    const entityType = op.entityType || value.entityType || value.type
    if (typeof entityType !== 'string' || !entityType) throw Object.assign(new Error('entity type required'), { status: 400 })
    state.entities[id] = { ...value, id, entityType, entityRevision: 1, updatedRevision: revision }
    return
  }
  if (!current || current.entityRevision !== op.expectedEntityRevision) throw Object.assign(new Error('entity conflict'), { status: 409 })
  if (op.type === 'delete') {
    delete state.entities[id]
    state.deletedIds[id] = revision
    return
  }
  state.entities[id] = { ...current, ...value, id, entityType: current.entityType, entityRevision: current.entityRevision + 1, updatedRevision: revision }
}

async function apply(body) {
  if (!body || typeof body.operationId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(body.operationId)) throw Object.assign(new Error('invalid operation id'), { status: 400 })
  return withFileLock(metadataLockFile, async () => {
    const state = await load()
    if (Object.hasOwn(state.operationIds, body.operationId)) return state.operationIds[body.operationId]
    if (!Number.isSafeInteger(body.baseRevision) || body.baseRevision !== state.revision) throw Object.assign(new Error('base revision conflict'), { status: 409 })
    const operations = Array.isArray(body.operations) ? body.operations : [body]
    if (!operations.length) throw Object.assign(new Error('operations required'), { status: 400 })
    const revision = state.revision + 1
    for (const op of operations) validateOperation(op, state, revision)
    state.revision = revision
    const result = { operationId: body.operationId, revision }
    state.operationIds[body.operationId] = result
    await atomicJson(metadataFile, state)
    return result
  })
}

export function applyOperations(body) {
  const result = pending.then(() => apply(body))
  pending = result.catch(() => {})
  return result
}
