import { CatalogTable, type CatalogRecord as RecordEntry } from '@/components/catalog-table'
import { CloudflareResources } from '@/components/cloudflare-resources'
import { useEffect, useState } from 'react'
import { apiFetch, type ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ModelsTabs } from '@/components/models-tabs'

type CatalogData = { records: RecordEntry[]; status: { appliedVersion: string | null; appliedTier: string | null; generatedAt: string | null; lastSyncMs: number | null; lastError: string | null; official: unknown; autoSync: { intervalHours: number; enabled: boolean }; providersWithoutChatModels: string[]; history: { id: number; at_ms: number; action: string; detail_json: string }[] } }
const stringify = (value: unknown) => JSON.stringify(value, null, 2)
const catalogKinds = ['chat','embedding','media','quirk']
const newCatalogRecord = (kind = 'chat') => ({
  kind,
  platform: kind === 'quirk' ? '' : 'nvidia',
  modelId: '',
  values: kind === 'quirk' ? { title: '', body: '', severity: 'info', targets: [] } : kind === 'embedding' ? { display_name: '', family: '', dimensions: 1024, enabled: 1 } : kind === 'media' ? { display_name: '', modality: 'image', enabled: 1 } : { display_name: '', context_window: null, rpm_limit: null, enabled: 1 },
  origin: 'manual',
  extensions: { credentialRequirement: '', freeQuota: '', requiresCreditCard: null, requiresPhone: null, requiresKyc: null, signupUrl: '', regions: [], notes: '', evidenceLinks: [] },
})
function CatalogFields({ json, onChange, fixedIdentity, disabled }: { json: string; onChange: (value: string) => void; fixedIdentity: boolean; disabled: boolean }) {
  let draft: RecordEntry
  try { draft = JSON.parse(json); if (!draft?.values) return null } catch { return null }
  const change = (key: string, value: unknown, core = false) => onChange(stringify(core ? { ...draft, values: { ...draft.values, [key]: value } } : { ...draft, [key]: value }))
  const changeKind = (nextKind: string) => onChange(stringify({ ...newCatalogRecord(nextKind), origin: draft.origin ?? 'manual', extensions: draft.extensions ?? newCatalogRecord(nextKind).extensions }))
  const numeric = draft.kind === 'chat' ? ['context_window','rpm_limit','rpd_limit','tpm_limit','tpd_limit','intelligence_rank','speed_rank'] : draft.kind === 'embedding' ? ['dimensions','max_input_tokens','priority'] : draft.kind === 'media' ? ['priority'] : []
  const text = draft.kind === 'quirk' ? ['title','body','severity'] : draft.kind === 'chat' ? ['display_name','size_label','monthly_token_budget'] : draft.kind === 'embedding' ? ['display_name','family','quota_label'] : ['display_name','modality','quota_label']
  return <fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    {!fixedIdentity && <label className="text-xs">类型<select aria-label="新增记录类型" className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm" value={draft.kind} onChange={e => changeKind(e.target.value)}>{catalogKinds.map(k => <option key={k} value={k}>{k}</option>)}</select></label>}
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
  const [tab, setTab] = useState('models')
  const [editor, setEditor] = useState<string | null>(null)
  const [selected, setSelected] = useState<RecordEntry | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<{ action: string; proposed: Record<string, unknown>; existing: RecordEntry } | null>(null)
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
  return <div className="mx-auto max-w-7xl space-y-6 p-6">
    <div className="flex flex-wrap items-center justify-between gap-4"><h1 className="text-2xl font-semibold">Catalog 目录管理</h1><ModelsTabs /></div>
    <div className="flex flex-wrap gap-2 border-b pb-3" aria-label="目录功能">{[['models','模型目录'],['updates','检查更新'],...(import.meta.env.VITE_RUNTIME === 'cloudflare' ? [['resources','Cloudflare 资源']] : [])].map(([id,label]) => <Button key={id} variant={tab === id ? 'default' : 'ghost'} aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</Button>)}</div>
    {error && <p role="alert" className="rounded border border-red-400 p-3 text-red-600">{error}</p>}
    {notice && <p role="status" className="rounded border p-3">{notice}</p>}
    {tab === 'updates' && <section className="space-y-5">
    <div className="grid gap-4 rounded-xl border p-5 text-sm sm:grid-cols-2 lg:grid-cols-3">
      <span>目录版本： {data?.status.appliedVersion ?? 'Bundled baseline'}</span><span>版本层级： {data?.status.appliedTier ?? '—'}</span><span>生成时间： {data?.status.generatedAt ?? '—'}</span>
      <span>最后检查: {data?.status.lastSyncMs ? new Date(data.status.lastSyncMs).toLocaleString() : '尚未检查'}</span>
      <span>自动检查: {data?.status.autoSync.enabled ? `每 ${data.status.autoSync.intervalHours} 小时` : '未启用'}</span>
      <span>状态: {busy ? '处理中' : data?.status.lastError || '就绪'}</span>
      <Button title="验证官方签名后同步；保留 user / ai 数据" disabled={busy} onClick={() => run(async () => { const result = await apiFetch<{ action: string; diff: { added: number; updated: number; removed: number }; detail?: string }>('/api/catalog/sync', { method: 'POST' }); setNotice(`${result.action} · 新增 ${result.diff.added} / 更新 ${result.diff.updated} / 删除 ${result.diff.removed}${result.detail ? ` · ${result.detail}` : ''}`); await reload() })}>检查更新</Button>
    </div>
      <section className="rounded-xl border p-5"><h2 className="mb-4 font-semibold">同步与管理历史</h2>
        {!data?.status.history.length && <p className="py-6 text-sm text-muted-foreground">暂无历史记录</p>}
        <div className="divide-y">{data?.status.history.map(h => <HistoryItem key={h.id} entry={h} />)}</div>
      </section>
      <details className="rounded-xl border p-4"><summary className="cursor-pointer text-sm">查看原始目录 JSON</summary><h3 className="mt-3 text-sm">官方签名快照</h3><pre className="max-h-80 overflow-auto text-xs">{stringify(data?.status.official)}</pre><h3 className="text-sm">当前目录</h3><pre className="max-h-80 overflow-auto text-xs">{stringify(data?.records)}</pre></details>
    </section>}
    {tab === 'resources' && import.meta.env.VITE_RUNTIME === 'cloudflare' && <CloudflareResources active />}
    {tab === 'models' && <section className="space-y-4">
    {!!data?.status.providersWithoutChatModels.length && <p className="rounded-lg border border-amber-400/50 bg-amber-500/5 p-3 text-sm" title="已配置凭证但没有启用聊天模型，请检查更新或手动添加准确的 Model ID。">待配置聊天模型：{data.status.providersWithoutChatModels.join('、')}</p>}
    <div className="flex flex-wrap gap-3">
      <Button disabled={busy} onClick={() => { setSelected(null); setConflict(null); setEditor(stringify(newCatalogRecord())) }}>新增记录</Button>
    </div>
    {!data ? <p className="p-10 text-center text-muted-foreground">{error ? '目录加载失败' : '正在加载目录…'}</p> : <CatalogTable records={data.records} busy={busy} onEdit={r => { setSelected(r); setConflict(null); setEditor(stringify(r)); }} />}
    </section>}
    {editor !== null && <section className="space-y-3 rounded-xl border p-4"><h2 className="font-semibold">{selected ? `${selected.platform} / ${selected.modelId}` : '新增目录记录'}</h2>
      {selected?.readOnly && <p className="text-sm text-muted-foreground">此记录关联特定端点，请前往 Provider 页面编辑。</p>}
      <CatalogFields json={editor} onChange={setEditor} fixedIdentity={!!selected} disabled={!!selected?.readOnly || busy} />
      <details><summary className="cursor-pointer text-sm">高级字段 / JSON 编辑</summary><p className="my-2 text-xs text-muted-foreground">extensions 可填写凭证要求、免费额度和证据链接。</p><textarea aria-label="目录记录 JSON" className="h-80 w-full rounded border bg-background p-3 font-mono text-xs" value={editor} onChange={e => setEditor(e.target.value)} readOnly={selected?.readOnly} /></details>
      <div className="flex gap-3"><Button disabled={busy || selected?.readOnly} onClick={() => run(async () => { const p = JSON.parse(editor); if (selected && (p.kind !== selected.kind || p.platform !== selected.platform || p.modelId !== selected.modelId)) throw new Error('编辑时不能更改 kind / platform / modelId'); await write(selected ? 'update' : 'create', p) })}>保存（人工接管）</Button>
      {selected && <><Button variant="outline" disabled={busy || selected.readOnly} onClick={() => run(() => write('delete', selected))}>删除</Button><Button variant="outline" disabled={busy || selected.readOnly} onClick={() => run(() => write('restore', selected))}>恢复官方版本</Button></>}
      <Button variant="ghost" onClick={() => { setEditor(null); setConflict(null) }}>关闭</Button></div>
    </section>}
    {conflict && <section role="alert" className="space-y-3 rounded-xl border border-amber-500 p-4"><h2 className="font-semibold">记录冲突 — 请明确选择覆盖或放弃</h2><p className="text-sm">操作：{conflict.action}。覆盖后由此次操作的来源管理；恢复官方版本会清除本条 Local Override 和附加情报。</p><div className="grid gap-3 md:grid-cols-2"><div>现有值<pre className="max-h-72 overflow-auto rounded bg-muted p-3 text-xs">{stringify(conflict.existing)}</pre></div><div>拟写入值<pre className="max-h-72 overflow-auto rounded bg-muted p-3 text-xs">{stringify(conflict.proposed)}</pre></div></div>
      <Button disabled={busy || conflict.existing.readOnly} onClick={() => run(() => write(conflict.action, { ...conflict.proposed, conflict: 'replace', expectedRevision: conflict.existing.revision }))}>确认覆盖 / 执行</Button> <Button variant="outline" onClick={() => setConflict(null)}>放弃</Button></section>}
  </div>
}

function HistoryItem({ entry }: { entry: CatalogData['status']['history'][number] }) {
  let detail: { diff?: { added?: number; updated?: number; removed?: number }; trigger?: string; action?: string; detail?: string; result?: { action?: string; detail?: string } } = {}
  try { detail = JSON.parse(entry.detail_json) ?? {} } catch { /* legacy history still available in details */ }
  const labels: Record<string, string> = { sync: '检查更新', create: '新增记录', update: '修改记录', delete: '删除记录', restore: '恢复官方', scheduled: '自动计划', premium: '高级版入口', 'catalog-page': '目录页面' }
  return <div className="py-4 text-sm"><div className="flex flex-wrap items-center gap-3"><span className="font-medium">{labels[entry.action] ?? entry.action}</span><time className="text-xs text-muted-foreground">{new Date(entry.at_ms).toLocaleString()}</time>{detail.trigger && <span className="text-xs text-muted-foreground">{labels[detail.trigger] ?? detail.trigger}</span>}</div>
    {detail.diff && <p className="mt-2 text-xs">新增 {detail.diff.added ?? 0} · 更新 {detail.diff.updated ?? 0} · 删除 {detail.diff.removed ?? 0}</p>}
    {detail.result && <p className="mt-2 text-xs">{detail.result.action}{detail.result.detail ? ` · ${detail.result.detail}` : ''}</p>}
    <details className="mt-2"><summary className="cursor-pointer text-xs text-muted-foreground">详细记录</summary><pre className="max-h-48 overflow-auto rounded bg-muted p-3 text-xs">{entry.detail_json}</pre></details>
  </div>
}
