#!/usr/bin/env node
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { openRuntime, openWorkspace } from '@evoscholar/core'
import { createServerApp } from './server'

const ws = openWorkspace()
const alerts: string[] = []
let app: ReturnType<typeof createServerApp> | undefined
const rt = openRuntime(ws, (m) => {
  alerts.push(m)
  app?.broadcastAll({ type: 'warning', message: m })
})
app = createServerApp(rt, { webDir: resolve(__dirname, '../../web/public'), alerts })
const PORT = Number(process.env.EVOSCHOLAR_PORT ?? 4317)

const server = createServer(app.handler)
server.listen(PORT, '127.0.0.1', () => {
  console.log(`EvoScholar 工作台：http://127.0.0.1:${PORT}`)
  console.log(`当前 genome：${rt.genomes.activeId()}`)
})

const shutdown = async () => {
  await app?.dispose()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
