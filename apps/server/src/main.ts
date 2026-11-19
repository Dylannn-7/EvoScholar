#!/usr/bin/env node
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { openRuntime, openWorkspace } from '@evoscholar/core'
import { createServerApp } from './server'
import { announcePairing, createLocalAuth } from './local-auth'
import type { AddressInfo } from 'node:net'

const ws = openWorkspace()
const alerts: string[] = []
let app: ReturnType<typeof createServerApp> | undefined
const rt = openRuntime(ws, (m) => {
  alerts.push(m)
  app?.broadcastAll({ type: 'warning', message: m })
})
const PORT = Number(process.env.EVOSCHOLAR_PORT ?? 4317)

void Promise.resolve(rt.executor.recover?.()).then(() => {
  const auth = createLocalAuth()
  app = createServerApp(rt, { webDir: resolve(__dirname, '../../web/public'), alerts, auth })
  const server = createServer(app.handler)
  server.listen(PORT, '127.0.0.1', () => {
    const port = (server.address() as AddressInfo).port
    announcePairing(port, auth)
    console.log(`当前 genome：${rt.genomes.activeId()}`)
    if (process.stdin.isTTY) {
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk: string) => {
        if (!chunk.includes('\n') && !chunk.includes('\r')) return
        auth.renew()
        announcePairing(port, auth)
      })
    }
  })
})

const shutdown = async () => {
  await app?.dispose()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
