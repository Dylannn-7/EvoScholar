import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Publish a complete replacement in one rename on the destination filesystem. */
export function atomicWriteFile(file: string, data: string | Buffer, mode?: number): void {
  const previous = statSync(file, { throwIfNoEntry: false })
  if (previous && !previous.isFile()) throw new Error('目标不是普通文件')
  const temp = join(dirname(file), `.evo-${randomUUID()}.tmp`)
  const fd = openSync(temp, 'wx', mode ?? (previous && (previous.mode & 0o777)))
  try {
    try {
      writeFileSync(fd, data)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, file)
  } finally {
    rmSync(temp, { force: true })
  }
}
