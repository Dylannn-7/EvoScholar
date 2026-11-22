import { esc } from './modal.js'

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(（])(https?:\/\/[^\s<)）]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
}

export function md(src) {
  const out = []
  const lines = String(src || '').split('\n')
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    const fence = /^```([^\s`]*)/.exec(l)
    if (fence) {
      const lang = fence[1] || ''
      const buf = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++])
      i++
      const code = buf.join('\n')
      out.push(
        `<div class="code-block"><div class="code-head"><span>${esc(lang || 'code')}</span><button type="button" class="copy-code-btn">复制</button></div><pre><code>${esc(code)}</code></pre></div>`
      )
      continue
    }
    if (/^\s*---+\s*$/.test(l)) {
      out.push('<hr>')
      i++
      continue
    }
    const h = /^(#{1,4})\s+(.*)/.exec(l)
    if (h) {
      const level = Math.min(3, h[1].length)
      out.push(`<h${level}>${inline(h[2])}</h${level}>`)
      i++
      continue
    }
    if (/^\s*>\s?/.test(l)) {
      const q = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`)
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const row = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const head = row(l)
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(row(lines[i++]))
      out.push(
        `<div class="table-wrap"><table><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</table></div>`
      )
      continue
    }
    if (/^\s*([-*]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l)
      const items = []
      while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+[.)])\s+/, ''))
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`)
      continue
    }
    if (!l.trim()) {
      i++
      continue
    }
    const para = []
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+[.)])\s+|\s*>\s?|\s*---+\s*$)/.test(lines[i])) para.push(lines[i++])
    out.push(`<p>${para.map(inline).join('<br>')}</p>`)
  }
  return out.join('')
}

const TOOL_META = {
  lit_search: { label: '检索文献', arg: (a) => a.query },
  lit_lookup: { label: '查询题录', arg: (a) => a.doi || a.arxiv || a.title },
  lit_verify: { label: '核验引用', arg: (a) => a.path || (Array.isArray(a.references) ? `${a.references.length} 条参考文献` : '') },
  lit_import: { label: '导入题录', arg: (a) => a.path || a.format },
  web_search: { label: '联网搜索', arg: (a) => a.query },
  web_fetch: { label: '抓取网页', arg: (a) => a.url },
  pdf_text: { label: '读取 PDF', arg: (a) => a.path },
  pdf_page_image: { label: '渲染 PDF 页面', arg: (a) => `${a.path || ''}${a.pages ? ` · p.${a.pages}` : ''}` },
  read_file: { label: '读取文件', arg: (a) => a.path },
  write_file: { label: '写入文件', arg: (a) => a.path },
  edit_file: { label: '编辑文件', arg: (a) => a.path },
  list_files: { label: '列出目录', arg: (a) => a.path || '.' },
  run_python: {
    label: '运行 Python',
    arg: (a) => {
      const code = String(a.code || a.script || '').trim()
      if (!code) return a.path || ''
      const lines = code.split('\n')
      const first = lines.find((x) => x.trim() && !x.trim().startsWith('#')) || lines[0]
      return `${first.trim().slice(0, 48)}${lines.length > 1 ? ` (${lines.length} 行)` : ''}`
    }
  },
  run_command: { label: '执行命令', arg: (a) => a.command },
  start_process: { label: '启动进程', arg: (a) => a.command },
  read_process: { label: '读取进程', arg: (a) => a.id },
  stop_process: { label: '停止进程', arg: (a) => a.id },
  http_get: { label: '本地请求', arg: (a) => a.url },
  read_skill: { label: '加载技能', arg: (a) => a.name },
  figure_check: { label: '图表检查', arg: (a) => [a.path, a.venue, a.columns || (a.target_width_mm ? `${a.target_width_mm} mm` : '')].filter(Boolean).join(' · ') },
  manuscript_check: { label: '稿件检查', arg: (a) => `${a.path || ''}${Array.isArray(a.packs) ? ` · ${a.packs.join(', ')}` : ''}` },
  check_feedback: { label: '记录反馈', arg: (a) => `${(a.ids || []).join(', ')} → ${a.verdict || ''}` }
}

export function formatToolSummary(name, args) {
  const meta = TOOL_META[name]
  const obj = args && typeof args === 'object' ? args : {}
  if (meta) {
    const detail = String(meta.arg(obj) ?? '').replace(/\s+/g, ' ').trim().slice(0, 96)
    return { label: meta.label, codeName: name, detail }
  }
  const fallback = Object.values(obj)
    .map((v) => String(typeof v === 'string' ? v : JSON.stringify(v)))
    .join(' · ')
    .slice(0, 96)
  return { label: name, codeName: name, detail: fallback }
}
