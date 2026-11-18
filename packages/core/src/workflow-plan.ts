export type WorkflowPlan = {
  review?: 'before-final'
  literature?: 'delegated' | 'split' | 'parallel'
}

export const WORKFLOW_OPERATORS = ['verify-output', 'split-research', 'merge-research', 'parallel-search'] as const
export type WorkflowOperator = typeof WORKFLOW_OPERATORS[number]

export function validateWorkflows(plan: WorkflowPlan | undefined, tools: readonly string[]): void {
  if (plan === undefined) return
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) ||
      Object.keys(plan).some((key) => key !== 'review' && key !== 'literature') ||
      (plan.review !== undefined && plan.review !== 'before-final') ||
      (plan.literature !== undefined && !['delegated', 'split', 'parallel'].includes(plan.literature)))
    throw new Error('工作流配置无效')
  if (plan.literature && (!tools.includes('lit_search') || !tools.includes('lit_verify')))
    throw new Error('文献工作流需要已启用的 lit_search 和 lit_verify')
}

export function workflowOperators(plan: WorkflowPlan | undefined, tools: readonly string[]): WorkflowOperator[] {
  const available: WorkflowOperator[] = plan?.review ? [] : ['verify-output']
  if (tools.includes('lit_search') && tools.includes('lit_verify')) {
    if (plan?.literature !== 'split') available.push('split-research')
    if (plan?.literature !== 'parallel') available.push('parallel-search')
    if (plan?.literature === 'split' || plan?.literature === 'parallel') available.push('merge-research')
  }
  return available
}

export function mutateWorkflow(plan: WorkflowPlan | undefined, operator: WorkflowOperator, tools: readonly string[]): WorkflowPlan {
  if (!workflowOperators(plan, tools).includes(operator)) throw new Error(`不可用的工作流变异：${operator}`)
  switch (operator) {
    case 'verify-output': return { ...plan, review: 'before-final' }
    case 'split-research': return { ...plan, literature: 'split' }
    case 'merge-research': return { ...plan, literature: 'delegated' }
    case 'parallel-search': return { ...plan, literature: 'parallel' }
  }
}
