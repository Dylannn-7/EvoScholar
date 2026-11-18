import { esc } from './modal.js'

export const VERSION_STATUS = {
  active: '当前上线', archived: '已归档', candidate: '候选',
  evaluating: '评测中', pending: '待审批', rejected: '已拒绝', discarded: '自动淘汰'
}

export function versionStatus(genome, candidateStatus) {
  return genome.status === 'active' || genome.status === 'archived' ? genome.status : candidateStatus || genome.status
}

export function renderLineage(entries, active, selected) {
  if (!entries.length) return '<p class="muted">暂无谱系记录</p>'
  const ids = new Set(entries.map((entry) => entry.id))
  const children = new Map()
  for (const node of entries) {
    const parent = ids.has(node.parent) ? node.parent : null
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(node)
  }

  const visited = new Set()
  const render = (node) => {
    if (visited.has(node.id)) return ''
    visited.add(node.id)
    const current = node.id === active
    const status = current ? 'active' : versionStatus(node, node.candidateStatus)
    const branches = (children.get(node.id) || []).map(render).join('')
    return `<li>
      <button type="button" class="lineage-node${current ? ' current' : ''}" data-lineage="${esc(node.id)}"
        aria-pressed="${node.id === selected}"${current ? ' aria-current="true"' : ''}>
        <span class="lin-dot ${esc(status)}" aria-hidden="true"></span>
        <code>${esc(node.id)}</code><span class="chip ${esc(status)}">${esc(VERSION_STATUS[status] || status)}</span>
        ${node.target ? `<span class="muted">${esc(node.target)}</span>` : ''}
      </button>
      ${branches ? `<ul>${branches}</ul>` : ''}
    </li>`
  }
  const roots = (children.get(null) || []).map(render).join('')
  return `<ul class="evo-tree" aria-label="Genome 父子关系">${roots}${entries.map(render).join('')}</ul>`
}
