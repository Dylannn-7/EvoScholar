import type { Runtime } from '@evoscholar/core'

type EvolutionRecord = { id: number; ts: string; session_id: string | null; text: string; data: string }
type HostRecord = { id: number; ts: string; session_id: string; payload: string }

/** Resolve exact records for a forged release, including records outside the timeline page's window. */
export function operatorEvidence(rt: Runtime, id: number) {
  const forge = rt.db.prepare(`
    SELECT id, ts, session_id, text, data FROM evolve_log
    WHERE id = ? AND kind = 'adjust' AND json_extract(data, '$.action') = 'kernel.forge'
  `).get(id) as EvolutionRecord | undefined
  if (!forge) return undefined
  const data = JSON.parse(forge.data) as {
    releaseId: string
    trigger?: { invocationId: string; tool: string }
  }
  const failure = data.trigger && forge.session_id ? rt.db.prepare(`
    SELECT id, ts, session_id, payload FROM events
    WHERE session_id = ? AND type = 'tool.result'
      AND json_extract(payload, '$.invocationId') = ? AND json_extract(payload, '$.isError') = 1
    ORDER BY id DESC LIMIT 1
  `).get(forge.session_id, data.trigger.invocationId) as HostRecord | undefined : undefined
  const approvals = rt.db.prepare(`
    SELECT id, ts, session_id, text, data FROM evolve_log WHERE kind = 'learned'
      AND json_extract(data, '$.action') = 'kernel.approve' AND json_extract(data, '$.releaseId') = ?
    ORDER BY id DESC LIMIT 1
  `).all(data.releaseId) as EvolutionRecord[]
  const runs = rt.db.prepare(`
    SELECT id, ts, session_id, payload FROM events
    WHERE type = 'host.kernel.run' AND json_extract(payload, '$.releaseId') = ?
    ORDER BY id DESC LIMIT 12
  `).all(data.releaseId) as HostRecord[]
  const evolution = (r: EvolutionRecord, label: string) => ({
    id: `evolve_log:${r.id}`, label, ts: r.ts, session: r.session_id,
    text: r.text, data: JSON.parse(r.data)
  })
  const host = (r: HostRecord, label: string, text: string) => ({
    id: `events:${r.id}`, label, ts: r.ts, session: r.session_id, text, data: JSON.parse(r.payload)
  })
  return {
    trigger: failure ? [host(failure, `同回合最近报错 · ${data.trigger!.tool}`, JSON.parse(failure.payload).preview)] : [],
    version: [evolution(forge, '锻造与沙箱测试'), ...approvals.map((r) => evolution(r, '人工批准'))],
    result: runs.map((r) => {
      const payload = JSON.parse(r.payload)
      return host(r, `${payload.ok ? '执行成功' : '执行失败'}${payload.input ? ` · ${payload.input}` : ''}`, payload.output)
    })
  }
}
