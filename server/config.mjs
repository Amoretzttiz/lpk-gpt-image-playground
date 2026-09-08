import { join } from 'node:path'

export const port = Number(process.env.PORT || 8787)
export const host = process.env.HOST || '0.0.0.0'
export const rootDir = join(
  process.env.PERSISTENCE_DIR || '/lzcapp/var/gpt-image-playground',
  'v0.8',
)
export const casDir = join(rootDir, 'cas')
export const snapshotFile = join(process.env.PERSISTENCE_DIR || '/lzcapp/var/gpt-image-playground', 'state.json')
export const snapshotLockFile = join(process.env.PERSISTENCE_DIR || '/lzcapp/var/gpt-image-playground', 'snapshot.lock')
export const backupDir = process.env.BACKUP_DIR || join(process.env.PERSISTENCE_DIR || '/lzcapp/var/gpt-image-playground', 'backups')
export const metadataFile = join(rootDir, 'metadata.json')
export const metadataLockFile = join(rootDir, 'metadata.lock')
export const maxBodyBytes = Number(process.env.MAX_BODY_BYTES || 128 * 1024 * 1024)
