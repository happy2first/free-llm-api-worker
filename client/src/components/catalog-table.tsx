import { useMemo, useState } from 'react'
import { Button } from './ui/button'
import { Input } from './ui/input'

export type CatalogRecord = { kind: string; platform: string; modelId: string; source: string; origin: string | null; extensions: Record<string, unknown>; values: Record<string, unknown>; revision: string; updatedAt: number | null; readOnly?: boolean; integration?: { connected: boolean; reason: string } }
type Column = { key: string; label: string; value: (r: CatalogRecord) => unknown; options?: string[]; numeric?: boolean; extra?: boolean; hint?: string }
const columns: Column[] = [
  { key: 'kind', label: '类型', value: r => r.kind, options: ['chat','embedding','media','quirk'] },
  { key: 'provider', label: 'Provider', value: r => r.platform },
  { key: 'model', label: '模型', value: r => r.modelId },
  { key: 'connected', label: '本系统接入', value: r => r.integration ? r.integration.connected ? '已接入' : '未接入' : '不适用', options: ['已接入','未接入','不适用'], hint: '模型启用且具备匹配凭证；不代表实时额度或调用测试通过。' },
  { key: 'enabled', label: '启用', value: r => r.kind === 'quirk' ? null : r.values.enabled === 1 ? '是' : '否', options: ['是','否'] },
  { key: 'source', label: '来源', value: r => r.source, options: ['freellm','user','ai'], hint: 'user / ai 记录不会被官方同步覆盖。' },
  { key: 'context', label: '上下文', value: r => r.values.context_window ?? r.values.max_input_tokens, numeric: true, hint: 'Token 数；空白表示未知。筛选支持 >=32000、<128000。' },
  ...['rpm','rpd','tpm','tpd'].map(key => ({ key, label: key.toUpperCase(), value: (r: CatalogRecord) => r.values[`${key}_limit`], numeric: true, extra: true, hint: `${key[0] === 'r' ? '请求数' : 'Token 数'} / ${key.endsWith('m') ? '分钟' : '天'}；支持 >、>=、<、<=、= 筛选。` })),
  { key: 'budget', label: '月 Token', value: r => r.values.monthly_token_budget, extra: true },
  { key: 'vision', label: '视觉', value: r => r.values.supports_vision == null ? null : r.values.supports_vision === 1 ? '是' : '否', options: ['是','否'], extra: true },
  { key: 'tools', label: '工具调用', value: r => r.values.supports_tools == null ? null : r.values.supports_tools === 1 ? '是' : '否', options: ['是','否'], extra: true },
  { key: 'rank', label: '智能排名', value: r => r.values.intelligence_rank ?? r.values.priority, numeric: true, extra: true },
  { key: 'speed', label: '速度排名', value: r => r.values.speed_rank, numeric: true, extra: true },
  { key: 'origin', label: 'Origin', value: r => r.origin, extra: true },
  { key: 'updated', label: '更新时间', value: r => r.updatedAt, hint: '记录最近变更时间；历史未知时间显示 —。筛选按本地日期文字匹配。' },
]
const display = (v: unknown) => v == null || v === '' ? '—' : String(v)
export function matchesCatalogFilter(value: unknown, filter: string, numeric = false) {
  if (!filter.trim()) return true
  if (value == null) return false
  if (numeric) {
    const m = filter.trim().match(/^(>=|<=|>|<|=)?\s*(\d+(?:\.\d+)?)$/)
    if (!m) return false
    const n = Number(value), target = Number(m[2])
    return m[1] === '>' ? n > target : m[1] === '>=' ? n >= target : m[1] === '<' ? n < target : m[1] === '<=' ? n <= target : n === target
  }
  return String(value).toLowerCase().includes(filter.trim().toLowerCase())
}
export function compareCatalogValues(a: unknown, b: unknown, desc: boolean) {
  if (a == null || a === '') return b == null || b === '' ? 0 : 1
  if (b == null || b === '') return -1
  const compared = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true })
  return desc ? -compared : compared
}
function FilterIcon() {
  return <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 5h16l-6 7v5l-4 2v-7L4 5Z" /></svg>
}
export function CatalogTable({ records, busy, onEdit }: { records: CatalogRecord[]; busy: boolean; onEdit: (r: CatalogRecord) => void }) {
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>({ key: 'updated', desc: true })
  const [extra, setExtra] = useState(false)
  const [filterOpen, setFilterOpen] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const shown = columns.filter(c => extra || !c.extra)
  const providers = useMemo(() => [...new Set(records.map(r => r.platform).filter(Boolean))].sort(), [records])
  const rows = useMemo(() => {
    const filtered = records.filter(r => JSON.stringify(r).toLowerCase().includes(search.toLowerCase()) && columns.every(c => {
      const v = c.key === 'updated' && r.updatedAt ? new Date(r.updatedAt).toLocaleString() : c.key === 'model' ? `${r.modelId} ${r.values.display_name ?? r.values.title ?? ''}` : c.value(r)
      return c.options || c.key === 'provider' ? !filters[c.key] || v === filters[c.key] : matchesCatalogFilter(v, filters[c.key] ?? '', c.numeric)
    }))
    if (!sort) return filtered
    const column = columns.find(c => c.key === sort.key)!
    return filtered.sort((a, b) => compareCatalogValues(column.value(a), column.value(b), sort.desc))
  }, [records, search, filters, sort])
  const pages = Math.max(1, Math.ceil(rows.length / pageSize)), current = Math.min(page, pages - 1)
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-3"><Input aria-label="搜索目录" className="max-w-sm" placeholder="搜索模型、Provider 或情报" value={search} onChange={e => { setSearch(e.target.value); setPage(0) }} /><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={extra} onChange={e => { setExtra(e.target.checked); setFilters({}); setFilterOpen(null); setPage(0) }} />额度与能力列</label><Button variant="ghost" onClick={() => { setSearch(''); setFilters({}); setFilterOpen(null); setPage(0) }}>清除筛选</Button><Button variant="ghost" disabled={!sort} onClick={() => { setSort(null); setPage(0) }}>清除排序</Button><span className="ml-auto text-xs text-muted-foreground">{rows.length} / {records.length} 条</span></div>
    <div className="max-h-[65vh] overflow-auto rounded-xl border"><table className="w-full text-left text-xs"><thead className="sticky top-0 z-10 bg-muted"><tr><th className="w-20 p-3">操作</th>{shown.map(c => <th className="min-w-28 p-3 align-top" key={c.key} aria-sort={sort?.key === c.key ? sort.desc ? 'descending' : 'ascending' : 'none'}>
      <div className="relative flex items-center gap-1 whitespace-nowrap font-medium" title={c.hint}>
        <span className="mr-auto">{c.label}</span>
        <button className="rounded p-1 hover:bg-background/70" aria-label={`排序${c.label}`} title={sort?.key === c.key ? sort.desc ? '当前降序，点击改为升序' : '当前升序，点击改为降序' : '排序'} onClick={() => setSort(s => ({ key: c.key, desc: s?.key === c.key ? !s.desc : false }))}><span aria-hidden="true">{sort?.key === c.key ? sort.desc ? '↓' : '↑' : '↕'}</span></button>
        <button className={`rounded p-1 hover:bg-background/70 ${filters[c.key] ? 'bg-background' : ''}`} aria-label={`打开${c.label}筛选`} aria-expanded={filterOpen === c.key} title={filters[c.key] ? `已筛选：${filters[c.key]}` : '筛选'} onClick={() => setFilterOpen(open => open === c.key ? null : c.key)}><FilterIcon /></button>
        {filterOpen === c.key && <div className="absolute right-0 top-full z-30 mt-2 min-w-48 rounded-lg border bg-background p-2 shadow-lg">
          {(c.options || c.key === 'provider') ? <select aria-label={`筛选${c.label}`} className="w-full rounded border bg-background p-1.5 font-normal" value={filters[c.key] ?? ''} onChange={e => { setFilters(f => ({ ...f, [c.key]: e.target.value })); setPage(0) }}><option value="">全部</option>{(c.options ?? providers).map(o => <option key={o}>{o}</option>)}</select> : <input autoFocus aria-label={`筛选${c.label}`} title={c.hint} placeholder={c.numeric ? '例如 >=1000' : '筛选…'} className="w-full min-w-20 rounded border bg-background p-1.5 font-normal" value={filters[c.key] ?? ''} onChange={e => { setFilters(f => ({ ...f, [c.key]: e.target.value })); setPage(0) }} />}
          <div className="mt-2 flex justify-end gap-1"><Button variant="ghost" size="sm" onClick={() => { setFilters(f => ({ ...f, [c.key]: '' })); setPage(0) }}>清除</Button><Button variant="outline" size="sm" onClick={() => setFilterOpen(null)}>完成</Button></div>
        </div>}
      </div>
    </th>)}</tr></thead><tbody>{rows.slice(current * pageSize, (current + 1) * pageSize).map((r, i) => <tr className="border-t hover:bg-muted/40" key={`${r.kind}:${r.platform}:${r.modelId}:${i}`}><td className="p-3"><Button variant="ghost" size="sm" disabled={busy} onClick={() => onEdit(r)}>编辑</Button></td>{shown.map(c => <td className="p-3" key={c.key} title={c.key === 'connected' ? r.integration?.reason : undefined}>{c.key === 'model' ? <div className="min-w-48 max-w-xs break-words"><div className="font-medium">{display(r.values.display_name ?? r.values.title ?? r.modelId)}</div><div className="mt-1 font-mono text-muted-foreground">{r.modelId}</div></div> : c.key === 'updated' ? <span className="whitespace-nowrap">{r.updatedAt ? new Date(r.updatedAt).toLocaleString() : '—'}</span> : c.key === 'connected' ? <span className={`whitespace-nowrap rounded-full px-2 py-1 ${r.integration?.connected ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-muted text-muted-foreground'}`}>{display(c.value(r))}</span> : display(c.value(r))}</td>)}</tr>)}{!rows.length && <tr><td colSpan={shown.length + 1} className="p-10 text-center text-muted-foreground">没有匹配的目录记录，请调整筛选条件。</td></tr>}</tbody></table></div>
    <div className="flex flex-wrap items-center justify-end gap-3 text-sm"><label className="flex items-center gap-2">每页<select aria-label="每页条数" className="rounded border bg-background px-2 py-1" value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(0) }}>{[10,25,50,100].map(size => <option key={size} value={size}>{size}</option>)}</select>条</label><span>{current + 1} / {pages}</span><Button variant="outline" size="sm" disabled={current === 0} onClick={() => setPage(current - 1)}>上一页</Button><Button variant="outline" size="sm" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>下一页</Button></div>
  </div>
}
