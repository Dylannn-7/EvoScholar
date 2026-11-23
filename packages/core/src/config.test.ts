import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadSettings } from './config'

test('loadSettings validates UI preferences independently and keeps legacy themes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'evo-settings-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const write = (ui: unknown) => writeFileSync(join(dir, 'settings.json'), JSON.stringify({ ui }))
  assert.equal(loadSettings(dir).ui, undefined)
  write({ theme: 'dark' })
  assert.deepEqual(loadSettings(dir).ui, { theme: 'dark' })
  write({ theme: 'sepia', onboardingCompleted: false, dismissedHints: { plugins: false, trajectory: 'yes', other: true } })
  assert.deepEqual(loadSettings(dir).ui, { onboardingCompleted: false, dismissedHints: { plugins: false } })
  write({ theme: 'light', onboardingCompleted: 'no', dismissedHints: null })
  assert.deepEqual(loadSettings(dir).ui, { theme: 'light' })
  write({ theme: 'system', onboardingCompleted: true, dismissedHints: { trajectory: true, plugins: true, library: false } })
  assert.deepEqual(loadSettings(dir).ui, {
    theme: 'system', onboardingCompleted: true, dismissedHints: { trajectory: true, plugins: true, library: false }
  })
})
