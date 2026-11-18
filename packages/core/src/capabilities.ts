import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { checkFeedbackStats, type RuleStats } from './checkfeedback'
import type { Runtime } from './session'
import { listSkills } from './skills'
import { TOOL_FACTORIES } from './tools'

export type SkillSummary = {
  name: string
  version: number
  description: string
  enabled: boolean
  activeVersion?: number
}

export type FigureRulepackSummary = {
  id: string
  name: string
  notes?: string
  widthMm?: { single?: number | null; double?: number | null }
  maxHeightMm?: number | null
  fontPt?: { min?: number | null; max?: number | null }
  rasterMinDpi?: number | null
  lineArtMinDpi?: number | null
  formats?: string[]
  colorblindSafe?: boolean | null
}

export type WritingRulepackSummary = {
  id: string
  name: string
  status: 'verified' | 'stub'
  description?: string
  variants: { id: string; label: string }[]
  ruleCount: number
  verifyCount: number
}

export type ToolSummary = { name: string; description: string; enabled: boolean; source: 'builtin' | 'evolved' | 'imported' }
export type CapabilitiesSummary = {
  genome: { id: string; note?: string; tools: string[]; budgets: Record<string, number | undefined> }
  skills: SkillSummary[]
  tools: ToolSummary[]
  figureRulepacks: FigureRulepackSummary[]
  writingRulepacks: WritingRulepackSummary[]
  feedbackStats: RuleStats[]
}

function readYamlDir(dir: string): Record<string, any>[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()
    .map((f) => {
      try {
        return YAML.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, any>
      } catch {
        return null
      }
    })
    .filter((x): x is Record<string, any> => !!x && typeof x.id === 'string')
}

/** Collect active genome skills/tools, rulepacks, and check feedback statistics for the web UI. */
export function getCapabilities(rt: Runtime): CapabilitiesSummary {
  const g = rt.genomes.load()
  const enabledSkills = new Map((g.skills ?? []).map((s) => [s.name, s.version]))
  const skills: SkillSummary[] = listSkills(rt.ws.root, g.skills)
    .map((s) => ({
      name: s.name,
      version: s.version,
      description: s.description,
      enabled: enabledSkills.has(s.name),
      activeVersion: enabledSkills.get(s.name)
    }))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))

  const figureRulepacks: FigureRulepackSummary[] = readYamlDir(join(rt.ws.root, 'rulepacks', 'figures')).map((d) => ({
    id: d.id,
    name: String(d.name ?? d.id),
    notes: d.notes ? String(d.notes) : undefined,
    widthMm: d.width_mm ? { single: d.width_mm.single ?? null, double: d.width_mm.double ?? null } : undefined,
    maxHeightMm: d.max_height_mm ?? null,
    fontPt: d.font ? { min: d.font.min_pt ?? null, max: d.font.max_pt ?? null } : undefined,
    rasterMinDpi: d.raster_min_dpi ?? null,
    lineArtMinDpi: d.line_art_min_dpi ?? null,
    formats: Array.isArray(d.formats?.preferred) ? d.formats.preferred.map(String) : undefined,
    colorblindSafe: d.color?.colorblind_safe ?? null
  }))

  const writingRulepacks: WritingRulepackSummary[] = readYamlDir(join(rt.ws.root, 'rulepacks', 'writing'))
    .map((d) => ({
      id: d.id,
      name: String(d.name ?? d.id),
      status: (d.status === 'stub' ? 'stub' : 'verified') as 'verified' | 'stub',
      description: d.description ? String(d.description) : undefined,
      variants: d.variants && typeof d.variants === 'object' ? Object.entries(d.variants).map(([id, label]) => ({ id, label: String(label) })) : [],
      ruleCount: Array.isArray(d.rules) ? d.rules.length : 0,
      verifyCount: Array.isArray(d.verify) ? d.verify.length : 0
    }))
    .sort((a, b) => (a.status === b.status ? b.ruleCount - a.ruleCount || a.id.localeCompare(b.id) : a.status === 'verified' ? -1 : 1))

  const env = { ws: rt.ws, cwd: rt.ws.dataDir, ledger: rt.ledger, category: () => 'usage' as const }
  const tools: ToolSummary[] = Object.entries(TOOL_FACTORIES).map(([name, f]) => {
    let description = ''
    try { description = f(env).description } catch {}
    return { name, description, enabled: g.tools.enabled.includes(name), source: 'builtin' as const }
  }).sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))

  return {
    genome: { id: g.id, note: g.note, tools: g.tools.enabled, budgets: g.budgets },
    skills,
    tools,
    figureRulepacks,
    writingRulepacks,
    feedbackStats: checkFeedbackStats(rt)
  }
}
