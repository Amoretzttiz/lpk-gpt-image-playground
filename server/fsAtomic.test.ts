// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { withFileLock } from './fsAtomic.mjs'

const children: ChildProcess[] = []
const directories: string[] = []

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function temporaryLock() {
  const directory = await mkdtemp(join(tmpdir(), 'gpt-file-lock-'))
  directories.push(directory)
  return join(directory, 'metadata.lock')
}

function waitForExit(child: ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    child.once('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      if (code === 0 || signal === 'SIGKILL') resolve()
      else reject(new Error('child exited ' + code + '/' + signal))
    })
  })
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await new Promise((resolve) => child.exitCode !== null || child.signalCode !== null ? resolve(undefined) : child.once('exit', resolve))
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('cross-process file lock', () => {
  it('serializes concurrent callbacks', async () => {
    const file = await temporaryLock()
    let concurrent = 0
    let maxConcurrent = 0
    const run = () => withFileLock(file, async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await wait(50)
      concurrent--
    }, { timeoutMs: 1000 })

    await Promise.all([run(), run(), run(), run()])
    expect(maxConcurrent).toBe(1)
  })

  it('times out without stealing a live lock', async () => {
    const file = await temporaryLock()
    let release = () => {}
    let locked = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { locked = resolve })
    const owner = withFileLock(file, async () => {
      locked()
      await gate
    })
    await entered

    await expect(withFileLock(file, async () => {}, { timeoutMs: 30 })).rejects.toMatchObject({
      message: 'metadata lock timeout',
      status: 503,
    })
    release()
    await owner
  })

  it('stays locked when a legacy flock path is replaced', async () => {
    const file = await temporaryLock()
    await writeFile(file + '.flock', 'old inode')
    let release = () => {}
    let locked = () => {}
    let contenderEntered = false
    const gate = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { locked = resolve })
    const owner = withFileLock(file, async () => {
      locked()
      await gate
    })
    await entered

    await rename(file + '.flock', file + '.flock.old')
    await writeFile(file + '.flock', 'new inode')
    await expect(withFileLock(file, async () => { contenderEntered = true }, { timeoutMs: 30 })).rejects.toMatchObject({
      message: 'metadata lock timeout',
      status: 503,
    })
    expect(contenderEntered).toBe(false)

    release()
    await owner
    await expect(withFileLock(file, async () => { contenderEntered = true }, { timeoutMs: 1000 })).resolves.toBeUndefined()
    expect(contenderEntered).toBe(true)
  })

  it('releases the kernel lock when a callback throws', async () => {
    const file = await temporaryLock()
    await expect(withFileLock(file, async () => { throw new Error('callback failed') })).rejects.toThrow('callback failed')
    await expect(withFileLock(file, async () => 'acquired', { timeoutMs: 1000 })).resolves.toBe('acquired')
  })

  it('releases the kernel lock after its owner is killed', async () => {
    const file = await temporaryLock()
    const moduleUrl = new URL('./fsAtomic.mjs', import.meta.url).href
    const script = 'import { withFileLock } from ' + JSON.stringify(moduleUrl) + '; await withFileLock(process.argv[1], async () => { console.log("locked"); await new Promise(() => setInterval(() => {}, 1000)) })'
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, file], { stdio: ['ignore', 'pipe', 'inherit'] })
    children.push(child)
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.stdout?.once('data', () => resolve())
    })

    child.kill('SIGKILL')
    await waitForExit(child)
    await expect(withFileLock(file, async () => 'recovered', { timeoutMs: 1000 })).resolves.toBe('recovered')
  })

  it.each(['directory', 'file'])('ignores and preserves a legacy owner %s', async (kind) => {
    const file = await temporaryLock()
    if (kind === 'directory') {
      await mkdir(file)
      await writeFile(join(file, 'owner.json'), '{broken legacy owner')
    } else {
      await writeFile(file, 'legacy owner')
    }

    await withFileLock(file, async () => {}, { timeoutMs: 1000 })
    const legacy = await stat(file)
    expect(legacy.isDirectory()).toBe(kind === 'directory')
    expect(legacy.isFile()).toBe(kind === 'file')
    if (kind === 'directory') expect(await readFile(join(file, 'owner.json'), 'utf8')).toBe('{broken legacy owner')
    else expect(await readFile(file, 'utf8')).toBe('legacy owner')
    await expect(stat(file + '.flock')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes a multi-process stress run', async () => {
    const file = await temporaryLock()
    const log = file + '.events'
    const moduleUrl = new URL('./fsAtomic.mjs', import.meta.url).href
    const script = 'import { appendFile } from "node:fs/promises"; import { withFileLock } from ' + JSON.stringify(moduleUrl) + '; for (let i = 0; i < 5; i++) await withFileLock(process.argv[1], async () => { await appendFile(process.argv[2], "+" + process.pid + "\\n"); await new Promise((resolve) => setTimeout(resolve, 5)); await appendFile(process.argv[2], "-" + process.pid + "\\n") }, { timeoutMs: 5000 })'
    const runs = Array.from({ length: 6 }, () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, file, log], { stdio: 'inherit' })
      children.push(child)
      return waitForExit(child)
    })
    await Promise.all(runs)

    let concurrent = 0
    let maxConcurrent = 0
    const events = (await readFile(log, 'utf8')).trim().split('\n')
    for (const event of events) {
      concurrent += event[0] === '+' ? 1 : -1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
    }
    expect(events).toHaveLength(60)
    expect(maxConcurrent).toBe(1)
    expect(concurrent).toBe(0)
  })
})
