import { useEffect, useMemo, useState } from 'react'
import { apiFetch, type ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ModelsTabs } from '@/components/models-tabs'

type RecordEntry = { kind: string; platform: string; modelId: string; source: string; origin: string | null; extensions: Record<string, unknown>; values: Record<string, unknown>; revision: string; updatedAt: number | null; readOnly?: boolean; integration?: { connected: boolean; reason: string } }
type CatalogData = { records: RecordEntry[]; status: { appliedVersion: string | null; appliedTier: string | null; generatedAt: string | null; lastSyncMs: number | null; lastError: string | null; official: unknown; autoSync: { intervalHours: number; enabled: boolean }; providersWithoutChatModels: string[]; history: { id: number; at_ms: number; action: string; detail_json: string }[] } }
const stringify = (value: unknown) => JSON.stringify(value, null, 2)
function CatalogFields({ json, onChange, fixedIdentity, disabled }: { json: string; onChange: (value: string) => void; fixedIdentity: boolean; disabled: boolean }) {
  let draft: RecordEntry
  try { draft = JSON.parse(json); if (!draft?.values) return null } catch { return null }
  const change = (key: string, value: unknown, core = false) => onChange(stringify(core ? { ...draft, values: { ...draft.values, [key]: value } } : { ...draft, [key]: value }))
  const numeric = draft.kind === 'chat' ? ['context_window','rpm_limit','rpd_limit','tpm_limit','tpd_limit','intelligence_rank','speed_rank'] : draft.kind === 'embedding' ? ['dimensions','max_input_tokens','priority'] : draft.kind === 'media' ? ['priority'] : []
  const text = draft.kind === 'quirk' ? ['title','body','severity'] : draft.kind === 'chat' ? ['display_name','size_label','monthly_token_budget'] : draft.kind === 'embedding' ? ['display_name','family','quota_label'] : ['display_name','modality','quota_label']
  return <fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    <label className="text-xs">Provider / platform<Input disabled={fixedIdentity || draft.kind === 'quirk'} value={draft.platform ?? ''} onChange={e => change('platform', e.target.value)} /></label>
    <label className="text-xs">Model ID / Quirk slug<Input disabled={fixedIdentity} value={draft.modelId ?? ''} onChange={e => change('modelId', e.target.value)} /></label>
    <label className="text-xs">Origin<Input value={draft.origin ?? ''} onChange={e => change('origin', e.target.value)} /></label>
    {text.map(key => <label key={key} className="text-xs">{key}<Input value={String(draft.values[key] ?? '')} onChange={e => change(key, e.target.value, true)} /></label>)}
    {numeric.map(key => <label key={key} className="text-xs">{key}<Input type="number" min="0" step="1" placeholder="未知 / 无限制" value={String(draft.values[key] ?? '')} onChange={e => change(key, e.target.value === '' ? null : Number(e.target.value), true)} /></label>)}
    {(draft.kind === 'chat' ? ['enabled','supports_vision','supports_tools'] : draft.kind === 'quirk' ? [] : ['enabled']).map(key => <label key={key} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={draft.values[key] === 1} onChange={e => change(key, e.target.checked ? 1 : 0, true)} />{key}</label>)}
  </fieldset>
}
export default function CatalogPage() {
  const [data, setData] = useState<CatalogData | null>(null)
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState('')
  const [source, setSource] = useState('')
  const [editor, setEditor] = useState<string | null>(null)
  const [selected, setSelected] = useState<RecordEntry | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<{ action: string; proposed: Record<string, unknown>; existing: RecordEntry } | null>(null)
  const [resources, setResources] = useState<unknown>(null)
  const reload = async () => setData(await apiFetch<CatalogData>('/api/catalog'))
  useEffect(() => { let active = true; apiFetch<CatalogData>('/api/catalog').then(value => { if (active) setData(value) }).catch(e => { if (active) setError(e.message) }); return () => { active = false } }, [])
  const run = async (job: () => Promise<void>) => { setBusy(true); setError(''); try { await job() } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }
  const write = async (action: string, proposed: Record<string, unknown>) => {
    try {
      await apiFetch(`/api/catalog/records/${action}`, { method: 'POST', body: JSON.stringify(proposed) })
      setConflict(null); setEditor(null); setSelected(null); setNotice('已保存。'); await reload()
    } catch (e) {
      const failure = e as ApiError
      if (failure.status === 409 && failure.details?.existing) {
        setConflict({ action, proposed: (failure.details.proposed as Record<string, unknown>) ?? proposed, existing: failure.details.existing as RecordEntry }); return
      }
      throw e
    }
  }
  const rows = useMemo(() => data?.records.filter(r => (!kind || r.kind === kind) && (!source || r.source === source) && stringify(r).toLowerCase().includes(search.toLowerCase())) ?? [], [data, kind, source, search])
  const cell = (v: unknown) => v === null || v === undefined ? '—' : String(v)
  return <div className="mx-auto max-w-7xl space-y-6 p-6">
    <div className="flex flex-wrap items-center justify-between gap-4"><h1 className="text-2xl font-semibold">Catalog 目录管理</h1><ModelsTabs /></div>
    <p className="text-sm text-muted-foreground">在同一目录查看和维护 Chat、Embeddings、Media 与 Quirks。来源 user / ai 的记录不会被官方月度同步覆盖；编辑目录不会自动创建 Provider 凭证。“已接入”表示模型已启用且有范围匹配的已启用凭证（healthy / unknown），不代表实时额度、冷却状态或上游调用测试通过。</p>
    {error && <p role="alert" className="rounded border border-red-400 p-3 text-red-600">{error}</p>}
    {notice && <p role="status" className="rounded border p-3">{notice}</p>}
    <div className="flex flex-wrap items-center gap-5 rounded-xl border p-4 text-sm">
      <span>Version: {data?.status.appliedVersion ?? 'Bundled baseline'}</span><span>Tier: {data?.status.appliedTier ?? '—'}</span><span>Generated: {data?.status.generatedAt ?? '—'}</span>
      <span>最后检查: {data?.status.lastSyncMs ? new Date(data.status.lastSyncMs).toLocaleString() : '尚未检查'}</span>
      <span>自动检查: {data?.status.autoSync.enabled ? `每 ${data.status.autoSync.intervalHours} 小时` : '未启用'}</span>
      <span>状态: {busy ? '处理中' : data?.status.lastError || '就绪'}</span>
      <Button disabled={busy} onClick={() => run(async () => { const result = await apiFetch<{ action: string; diff: unknown; detail?: string }>('/api/catalog/sync', { method: 'POST' }); setNotice(`${result.action}: ${stringify(result.diff)} ${result.detail ?? ''}`); await reload() })}>检查更新（签名校验）</Button>
    </div>
    {!!data?.status.providersWithoutChatModels.length && <p className="rounded border border-amber-400 p-3 text-sm">已配置凭证但没有启用聊天模型的 Provider：{data.status.providersWithoutChatModels.join('、')}。密钥与模型目录是独立配置；先检查签名目录更新，或新增 platform 与 Provider 一致的模型记录。Model ID 请以提供商 API 文档或账户可用模型为准，目录信息本身不保证免费额度。</p>}
    <div className="flex flex-wrap gap-3">
      <Input className="max-w-sm" placeholder="搜索 Provider、模型或情报字段" value={search} onChange={e => setSearch(e.target.value)} />
      <select aria-label="目录类型" className="rounded border bg-background p-2" value={kind} onChange={e => setKind(e.target.value)}><option value="">全部类型</option>{['chat','embedding','media','quirk'].map(k => <option key={k}>{k}</option>)}</select>
      <select aria-label="来源" className="rounded border bg-background p-2" value={source} onChange={e => setSource(e.target.value)}><option value="">全部来源</option>{['freellm','user','ai'].map(k => <option key={k}>{k}</option>)}</select>
      <Button disabled={busy} onClick={() => { setSelected(null); setConflict(null); setEditor(stringify({ kind: kind || 'chat', platform: kind === 'quirk' ? '' : 'nvidia', modelId: '', values: kind === 'quirk' ? { title: '', body: '', severity: 'info', targets: [] } : kind === 'embedding' ? { display_name: '', family: '', dimensions: 1024, enabled: 1 } : kind === 'media' ? { display_name: '', modality: 'image', enabled: 1 } : { display_name: '', context_window: null, rpm_limit: null, enabled: 1 }, origin: 'manual', extensions: { credentialRequirement: '', freeQuota: '', requiresCreditCard: null, requiresPhone: null, requiresKyc: null, signupUrl: '', regions: [], notes: '', evidenceLinks: [] } })) }}>新增记录</Button>
      <span className="self-center text-sm">{rows.length} 条</span>
    </div>
    <div className="max-h-[560px] overflow-auto rounded-xl border"><table className="w-full text-left text-xs"><thead className="sticky top-0 bg-background"><tr>{['类型 / Provider','Model ID / 名称','Context','RPM / RPD','TPM / TPD','月 Token','Vision / Tools','Rank / Speed','Enabled','本系统接入','来源 / Origin','更新时间','操作'].map(x => <th className="p-3" key={x}>{x}</th>)}</tr></thead><tbody>{rows.map((r, i) => <tr className="border-t" key={`${r.kind}:${r.platform}:${r.modelId}:${i}`}>
      <td className="p-3">{r.kind}<br />{r.platform}</td><td className="max-w-xs break-words p-3">{r.modelId}<br /><span className="text-muted-foreground">{cell(r.values.display_name ?? r.values.title)}</span></td><td className="p-3">{cell(r.values.context_window ?? r.values.max_input_tokens)}</td><td className="p-3">{cell(r.values.rpm_limit)} / {cell(r.values.rpd_limit)}</td><td className="p-3">{cell(r.values.tpm_limit)} / {cell(r.values.tpd_limit)}</td><td className="p-3">{cell(r.values.monthly_token_budget)}</td><td className="p-3">{cell(r.values.supports_vision)} / {cell(r.values.supports_tools)}</td><td className="p-3">{cell(r.values.intelligence_rank ?? r.values.priority)} / {cell(r.values.speed_rank)}</td><td className="p-3">{cell(r.values.enabled)}</td><td className="p-3">{r.integration?.reason ?? '不适用'}</td><td className="p-3">{r.source}<br />{r.origin ?? '—'}</td><td className="whitespace-nowrap p-3">{r.updatedAt ? new Date(r.updatedAt).toLocaleString() : '未知（历史记录）'}</td><td className="p-3"><Button variant="outline" size="sm" disabled={busy} onClick={() => { setSelected(r); setConflict(null); setEditor(stringify(r)); }}>详情 / 编辑</Button></td>
    </tr>)}</tbody></table></div>
    {editor !== null && <section className="space-y-3 rounded-xl border p-4"><h2 className="font-semibold">{selected ? `${selected.platform} / ${selected.modelId}` : '新增目录记录'}</h2>
      <p className="text-sm text-muted-foreground">values 是现有目录字段；extensions 保存免费额度、凭证要求和证据。记录标识不支持原地改名，需另建记录。已关联特定端点的记录请在 Provider 页面编辑。</p>
      <CatalogFields json={editor} onChange={setEditor} fixedIdentity={!!selected} disabled={!!selected?.readOnly || busy} />
      <textarea aria-label="目录记录 JSON" className="h-80 w-full rounded border bg-background p-3 font-mono text-xs" value={editor} onChange={e => setEditor(e.target.value)} readOnly={selected?.readOnly} />
      <div className="flex gap-3"><Button disabled={busy || selected?.readOnly} onClick={() => run(async () => { const p = JSON.parse(editor); if (selected && (p.kind !== selected.kind || p.platform !== selected.platform || p.modelId !== selected.modelId)) throw new Error('编辑时不能更改 kind / platform / modelId'); await write(selected ? 'update' : 'create', p) })}>保存（人工接管）</Button>
      {selected && <><Button variant="outline" disabled={busy || selected.readOnly} onClick={() => run(() => write('delete', selected))}>删除</Button><Button variant="outline" disabled={busy || selected.readOnly} onClick={() => run(() => write('restore', selected))}>恢复官方版本</Button></>}
      <Button variant="ghost" onClick={() => { setEditor(null); setConflict(null) }}>关闭</Button></div>
    </section>}
    {conflict && <section role="alert" className="space-y-3 rounded-xl border border-amber-500 p-4"><h2 className="font-semibold">记录冲突 — 请明确选择覆盖或放弃</h2><p className="text-sm">操作：{conflict.action}。覆盖后由此次操作的来源管理；恢复官方版本会清除本条 Local Override 和附加情报。</p><div className="grid gap-3 md:grid-cols-2"><div>现有值<pre className="max-h-72 overflow-auto rounded bg-muted p-3 text-xs">{stringify(conflict.existing)}</pre></div><div>拟写入值<pre className="max-h-72 overflow-auto rounded bg-muted p-3 text-xs">{stringify(conflict.proposed)}</pre></div></div>
      <Button disabled={busy || conflict.existing.readOnly} onClick={() => run(() => write(conflict.action, { ...conflict.proposed, conflict: 'replace', expectedRevision: conflict.existing.revision }))}>确认覆盖 / 执行</Button> <Button variant="outline" onClick={() => setConflict(null)}>放弃</Button></section>}
    <details className="rounded-xl border p-4"><summary>原始 Catalog JSON（已验证官方快照 / 当前目录）</summary><h3 className="mt-3">官方签名快照</h3><pre className="max-h-80 overflow-auto text-xs">{stringify(data?.status.official)}</pre><h3>当前有效目录（含 user / ai）</h3><pre className="max-h-80 overflow-auto text-xs">{stringify(data?.records)}</pre></details>
    <details className="rounded-xl border p-4"><summary>同步 / 管理历史</summary>{data?.status.history.map(h => <div className="border-b py-3 text-sm" key={h.id}>{new Date(h.at_ms).toLocaleString()} · {h.action}<pre className="overflow-auto text-xs">{h.detail_json}</pre></div>)}</details>
    <details className="space-y-3 rounded-xl border p-4"><summary>MCP 与 Cloudflare 资源统计</summary><p className="py-3 text-sm">Catalog MCP：<code>{location.origin}/api/catalog/mcp</code>。与管理后台使用相同身份验证；下游应用 API Key 无权访问。支持 search / read / create / update / delete / restore，MCP 写入来源为 ai。</p>
      {import.meta.env.VITE_RUNTIME === 'cloudflare' && <><p className="text-sm">成功请求分析已移至 Analytics Engine；旧 Analytics 页面仅包含历史与异常数据。近期日志和以下 SQL 统计在内存中，重启后清空。</p><Button disabled={busy} onClick={() => run(async () => setResources(await apiFetch('/api/runtime/resources')))}>读取 SQL 统计（不写库）</Button><pre className="max-h-80 overflow-auto text-xs">{stringify(resources)}</pre></>}
    </details>
  </div>
}
