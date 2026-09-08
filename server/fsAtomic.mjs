import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

export async function atomicWrite(file, data) {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const temporary = file + '.' + process.pid + '.' + randomBytes(8).toString('hex') + '.tmp'
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    await rename(temporary, file)
    await chmod(file, 0o600)
    const directoryHandle = await open(directory, 'r')
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } catch (error) {
    await handle.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export async function atomicJson(file, value) {
  await atomicWrite(file, JSON.stringify(value) + '\n')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function tryFlock(handle) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/flock', ['-n', '3'], {
      stdio: ['ignore', 'ignore', 'pipe', handle.fd],
    })
    let stderr = ''
    let settled = false
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      if (code === 0) return resolve(true)
      if (code === 1) return resolve(false)
      reject(new Error('flock failed' + (signal ? ' with signal ' + signal : ' with exit code ' + code) + (stderr ? ': ' + stderr.trim() : '')))
    })
  })
}

export async function withFileLock(file, callback, options = {}) {
  const startedAt = Date.now()
  const timeoutMs = options.timeoutMs ?? 5000
  const directory = dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)

  while (true) {
    // 持久化根目录是信任锚；同 UID 替换整个根目录不属于受支持的并发模型。
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      if (await tryFlock(handle)) {
        try {
          return await callback()
        } finally {
          await handle.close()
        }
      }
    } finally {
      await handle.close().catch(() => {})
    }
    if (Date.now() - startedAt >= timeoutMs) throw Object.assign(new Error('metadata lock timeout'), { status: 503 })
    await sleep(10 + Math.floor(Math.random() * 20))
  }
}
