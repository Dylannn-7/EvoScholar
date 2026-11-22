import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fetchProviderModels, getCapabilities, openRuntime, openWorkspace, recordCheckFeedback, resolveProviderParameters, listProviders, saveSettings } from './index'
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
    const thesis = cap.writingRulepacks.find((w) => w.id === 'hust-thesis')!
    assert.equal(thesis.status, 'verified')
    assert.ok(thesis.variants.length >= 3)
    assert.equal(thesis.verifyCount, thesis.verify.length)
    assert.ok(thesis.verify.some((item) => item.applies?.includes('doctor') && item.text.includes('100 篇')))
    assert.ok(thesis.sources.some((s) => s.url?.startsWith('https://gs.hust.edu.cn/')))
    assert.equal(cap.writingRulepacks.length, 20)
    assert.ok(cap.writingRulepacks.every((pack) => pack.status === 'verified' && pack.ruleCount > 0))
    const optics = cap.writingRulepacks.find((pack) => pack.id === 'cn-optics')!
    assert.deepEqual(optics.extends, ['common'])
    const irlaNote = optics.verify.find((item) => item.applies?.includes('irla'))!
    assert.equal(irlaNote.source, 'irla')
    assert.ok(optics.sources.some((source) => source.id === irlaNote.source && source.url?.includes('spacejournal.cn')))
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

    const res = await fetchProviderModels(ws.config, 'deepseek', mockFetch)
    assert.ok(res.ok)
    assert.equal(res.models.length, 2)
    ws.settings.providers.deepseek = { models: res.models, modelsFetchedAt: new Date().toISOString() }
    saveSettings(ws)
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
    assert.equal(openWorkspace(dir).settings.providers.deepseek.models?.length, 2, 'fetched models persist in data/settings.json')
  } finally {
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

test('legacy cap settings cannot price or block new product usage', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'evo-usage-only-'))
  cpSync(join(REPO, 'evoscholar.config.json'), join(dir, 'evoscholar.config.json'))
  const ws = openWorkspace(dir)
  ws.config.budget.enforceUsageCap = true
  ws.config.budget.totalCny = 0
  const rt = openRuntime(ws, () => {})
  t.after(() => { rt.db.close(); rmSync(dir, { recursive: true, force: true }) })
  assert.doesNotThrow(() => rt.ledger.assertCanSpend('usage', 100))
  const usd = rt.ledger.record({ category: 'usage', kind: 'model', provider: 'deepseek', inputTokens: 11, outputTokens: 3, costUsd: 1 })
  assert.equal(usd, 0)
  assert.deepEqual({ ...rt.db.prepare('SELECT cost_cny, input_tokens, output_tokens FROM ledger').get() },
    { cost_cny: 0, input_tokens: 11, output_tokens: 3 })
  assert.throws(() => rt.ledger.assertCanSpend('dev', 1), BudgetError)
})
