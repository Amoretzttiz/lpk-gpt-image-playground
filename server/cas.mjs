import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { casDir, maxBodyBytes } from './config.mjs'
import { atomicWrite } from './fsAtomic.mjs'

const TYPES = {
  'image/png': (data) => data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && data.readUInt32BE(8) === 13 && data.subarray(12, 16).toString('ascii') === 'IHDR',
  'image/jpeg': (data) => data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9,
  'image/webp': (data) => data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP' && data.readUInt32LE(4) === data.length - 8,
}

export function validHash(hash) {
  return /^[a-f0-9]{64}$/.test(hash)
}

export function blobFile(hash) {
  return join(casDir, hash.slice(0, 2), hash)
}

export async function readBytes(req) {
  const declared = Number(req.headers['content-length'])
  if (!Number.isSafeInteger(declared) || declared < 1 || declared > maxBodyBytes) throw Object.assign(new Error('invalid content length'), { status: 400 })
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > declared || size > maxBodyBytes) throw Object.assign(new Error('invalid content length'), { status: 400 })
    chunks.push(chunk)
  }
  if (size !== declared) throw Object.assign(new Error('invalid content length'), { status: 400 })
  return Buffer.concat(chunks)
}

export async function putBlob(req, hash) {
  if (!validHash(hash)) throw Object.assign(new Error('invalid hash'), { status: 400 })
  const type = req.headers['content-type']
  if (!TYPES[type]) throw Object.assign(new Error('unsupported media type'), { status: 415 })
  const data = await readBytes(req)
  if (!TYPES[type](data)) throw Object.assign(new Error('media bytes do not match content type'), { status: 415 })
  if (createHash('sha256').update(data).digest('hex') !== hash) throw Object.assign(new Error('hash mismatch'), { status: 422 })
  await atomicWrite(blobFile(hash), data)
  return { hash, size: data.length, contentType: type }
}

export async function blobStat(hash) {
  if (!validHash(hash)) return null
  try {
    return await stat(blobFile(hash))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function blobContentType(hash) {
  const handle = await open(blobFile(hash), 'r')
  try {
    const data = Buffer.alloc(24)
    const result = await handle.read(data, 0, data.length, 0)
    const head = data.subarray(0, result.bytesRead)
    if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
    if (head.length >= 2 && head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg'
    return 'image/webp'
  } finally {
    await handle.close()
  }
}

export function parseRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2])) return null
  const suffix = !match[1]
  const start = suffix ? Math.max(0, size - Number(match[2])) : Number(match[1])
  const end = suffix ? size - 1 : match[2] ? Math.min(size - 1, Number(match[2])) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return null
  return { start, end, partial: true }
}

export async function readBlob(hash, range) {
  const handle = await open(blobFile(hash), 'r')
  try {
    const data = Buffer.alloc(range.end - range.start + 1)
    await handle.read(data, 0, data.length, range.start)
    return data
  } finally {
    await handle.close()
  }
}
