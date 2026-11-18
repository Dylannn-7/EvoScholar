import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { clearLiveModelCache, getCapabilities, openRuntime, openWorkspace, recordCheckFeedback, refreshProviderModels, resolveProviderParameters, listProviders } from './index'
import { BudgetError, Ledger } from './budget'

const REPO = resolve(__dirname, '../../..')

test('getCapabilities collects skills, figure/writing rulepacks, and feedback stats', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evo-cap-'))
  try {
    cpSync(join(REPO, 'evoscholar.config.json'), join(dir, 'evoscholar.config.json'))
    cpSync(join(REPO, 'genomes'), join(dir, 'genomes'), { recursive: true })
    cpSync(join(REPO, 'prompts'), join(dir, 'prompts'), { recursive: true })
    cpSync(join(REPO, 'skills'), join(dir, 'skills'), { recursive: true })
    cpSync(join(REPO, 'rulepacks', 'figures'), join(dir, 'rulepacks', 'figures'), { recursive: true })
    cpSync(join(REPO, 'rulepacks', 'writing'), join(dir, 'rulepacks', 'writing'), { recursive: true })
    mkdirSync(join(dir, 'data'))
    writeFileSync(join(dir, '.env'), '')

    const ws = openWorkspace(dir)
    const rt = openRuntime(ws, () => {})
    recordCheckFeedback(rt, [
      { kind: 'check.feedback', file: 'main.tex', finding: 'F001', rule: 'common.abbreviations', pack: 'common', verdict: 'false_positive' },
      { kind: 'check.feedback', file: 'main.tex', finding: 'F002', rule: 'common.xref', pack: 'common', verdict: 'valid' }
    ])

    const cap = getCapabilities(rt)
    assert.ok(cap.skills.length >= 12)
    assert.ok(cap.skills.some((s) => s.name === 'literature-review' && s.enabled))
    assert.ok(cap.figureRulepacks.some((f) => f.id === 'nature' && f.widthMm?.single === 89))
    assert.ok(cap.writingRulepacks.some((w) => w.id === 'hust-thesis' && w.status === 'verified' && w.variants.length >= 3))
    assert.ok(cap.writingRulepacks.some((w) => w.id === 'aaai' && w.status === 'stub'))
    const abbr = cap.feedbackStats.find((s) => s.rule === 'common.abbreviations')
    assert.equal(abbr?.false_positive, 1)
    assert.equal(abbr?.fp_rate, 1)
    rt.db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('provider effort translation and live model list refresh', async () => {
  assert.deepEqual(resolveProviderParameters('chat-completions', 'deepseek', { effort: 'none' }), { thinking: { type: 'disabled' } })
  assert.deepEqual(resolveProviderParameters('chat-completions', 'deepseek', { effort: 'high' }), { thinking: { type: 'enabled' }, reasoning_effort: 'high' })
  assert.deepEqual(resolveProviderParameters('messages', 'deepseek', { effort: 'low' }), { thinking: { type: 'enabled' }, output_config: { effort: 'low' } })
  assert.deepEqual(resolveProviderParameters('messages', 'anthropic', { effort: 'xhigh' }), { thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' } })
  assert.deepEqual(resolveProviderParameters('responses', 'openai', { effort: 'medium' }), { reasoning: { effort: 'medium' } })

  const dir = mkdtempSync(join(tmpdir(), 'evo-prov-'))
  const oldKey = process.env.DEEPSEEK_API_KEY
  try {
    cpSync(join(REPO, 'evoscholar.config.json'), join(dir, 'evoscholar.config.json'))
    mkdirSync(join(dir, 'data'))
    process.env.DEEPSEEK_API_KEY = 'sk-mock-ds'
    const ws = openWorkspace(dir)
    const mockFetch = (async () =>
      Response.json({
        data: [
          {
            id: 'deepseek-flash',
            context_window: 1000000,
            max_output_tokens: 384000,
            input_modalities: ['text', 'image']
          },
          {
            id: 'deepseek-live-exp',
            context_length: 256000,
            max_tokens: 65536,
            supported_reasoning_efforts: ['none', 'low', 'medium', 'high']
          }
        ]
      })) as unknown as typeof fetch

    const res = await refreshProviderModels(ws.config, 'deepseek', mockFetch)
    assert.equal(res.refreshed, true)
    assert.equal(res.count, 2)
    const ds = listProviders(ws.config).find((p) => p.id === 'deepseek')!
    assert.equal(ds.modelsSource, 'live')
    assert.deepEqual(
      ds.models.map((m) => m.id),
      ['deepseek-flash', 'deepseek-live-exp']
    )
    assert.equal(ds.models[0].contextWindow, 1000000)
    assert.equal(ds.models[0].maxOutputTokens, 384000)
    assert.equal(ds.models[0].vision, true)
    assert.deepEqual(ds.models[0].reasoningEffort, { supported: true, values: ['none', 'low', 'high', 'max'] })
    assert.equal(ds.models[1].contextWindow, 256000)
    assert.equal(ds.models[1].maxOutputTokens, 65536)
    assert.deepEqual(ds.models[1].reasoningEffort, { supported: true, values: ['none', 'low', 'medium', 'high'] })
  } finally {
    clearLiveModelCache()
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = oldKey
    rmSync(dir, { recursive: true, force: true })
  }
})

test('usage category does not enforce hard cap by default while dev category remains capped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evo-bdg-'))
  try {
    cpSync(join(REPO, 'evoscholar.config.json'), join(dir, 'evoscholar.config.json'))
    mkdirSync(join(dir, 'data'))
    const ws = openWorkspace(dir)
    const rt = openRuntime(ws, () => {})
    const ledger = new Ledger(rt.db, ws.config)

    ledger.record({ kind: 'model', category: 'dev', provider: 'deepseek', costUsd: 200 })
    assert.doesNotThrow(() => ledger.assertCanSpend('usage'))
    assert.throws(() => ledger.assertCanSpend('dev'), BudgetError)
    rt.db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
