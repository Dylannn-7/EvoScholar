import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shouldShowHint, shouldShowOnboarding } from '../public/ui/onboarding-state.js'

test('onboarding only opens automatically for a fresh workspace', () => {
  assert.equal(shouldShowOnboarding(null), false)
  assert.equal(shouldShowOnboarding({ providers: [{ hasKey: false }], sessions: [], projects: [] }), true)
  assert.equal(shouldShowOnboarding({ providers: [{ hasKey: true }] }), false)
  assert.equal(shouldShowOnboarding({ sessions: [{ id: 'one' }] }), false)
  assert.equal(shouldShowOnboarding({ projects: [{ id: 'one' }] }), false)
  assert.equal(shouldShowOnboarding({ ui: { onboardingCompleted: true } }), false)
})

test('each page hint is displayed until dismissed', () => {
  const state = { ui: { dismissedHints: { trajectory: true, plugins: false } } }
  assert.equal(shouldShowHint(state, 'trajectory'), false)
  assert.equal(shouldShowHint(state, 'plugins'), true)
  assert.equal(shouldShowHint(state, 'library'), true)
  assert.equal(shouldShowHint({}, 'trajectory'), true)
})
