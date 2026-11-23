export function shouldShowOnboarding (state) {
  if (!state || state.ui?.onboardingCompleted === true) return false
  const hasKey = (state.providers || []).some((p) => p.hasKey)
  const hasSessions = (state.sessions || []).length > 0
  const hasProjects = (state.projects || []).length > 0
  return !(hasKey || hasSessions || hasProjects)
}

export function shouldShowHint (state, id) {
  return !state?.ui?.dismissedHints?.[id]
}
