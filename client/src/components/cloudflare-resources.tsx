import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
type Storage = { usedBytes: number; limitMiB: number; overLimit: boolean; lastCleanup: { at: number; logs: number; conversations: number; remainingOverLimit: boolean } | null }
type Resources = { startedAt: number; analyticsEnabled: boolean; emitted: number; failed: number; storage: Storage; sql: { source: string; calls: number; read: number; written: number }[]; catalogSchedule: { intervalHours: number; lastRunMs: number | null } }
const mib = (n: number) => (n / 1024 / 1024).toFixed(2)
export function CloudflareResources({ active }: { active: boolean }) {
  const [data, setData] = useState<Resources | null>(null)
  const [limit, setLimit] = useState('768')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const load = async () => { const value = await apiFetch<Resources>('/api/runtime/resources'); setData(value); setLimit(String(value.storage.limitMiB)) }
  useEffect(() => {
    if (!active) return
    let live = true
    apiFetch<Resources>('/api/runtime/resources').then(value => { if (live) { setData(value); setLimit(String(value.storage.limitMiB)) } }).catch(e => { if (live) setError(e.message) })
    return () => { live = false }
  }, [active])
  const run = async (job: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await job() } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }
  const totals = data?.sql.reduce((a, r) => ({ read: a.read + r.read, written: a.written + r.written }), { read: 0, written: 0 })
  return <section className="mt-6 space-y-3 border-t pt-5 text-sm">
    <div className="flex items-center justify-between gap-3"><h3 className="font-medium">Cloudflare 服务器资源</h3><Button size="sm" variant="outline" disabled={busy} onClick={() => run(load)}>刷新</Button></div>
    <p className="text-xs text-muted-foreground">仅当前 Gateway 的存储和运行统计；不代表整个 Cloudflare 账户的每日额度、CPU 或内存使用量。</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}{notice && <p role="status">{notice}</p>}
    {data && <>
      <div>有效存储：{mib(data.storage.usedBytes)} / {data.storage.limitMiB} MiB</div>
      <progress className="w-full" aria-label="存储使用率" max={100} value={Math.min(100, data.storage.usedBytes / (data.storage.limitMiB * 1024 * 1024) * 100)} />
      <p className="text-xs text-muted-foreground">存储大小来自 Cloudflare SQLite databaseSize 接口，不包含 Analytics Engine 或其他 Worker 的数据。</p>
      {data.storage.overLimit && <p role="alert" className="text-amber-600">有效存储仍超过清理阈值。若核心数据或近期对话占用较多，自动清理不能保证降到阈值以下。</p>}
      <label className="block space-y-1">存储清理上限（MiB，默认 768）<Input aria-label="存储清理上限" type="number" min="64" max="10240" step="1" value={limit} onChange={e => setLimit(e.target.value)} /></label>
      <p className="text-xs text-muted-foreground">每 5 分钟检查，达到上限后按时间清理最旧日志和对话，目标降至 90%。保护最近 1 小时的对话，不删除密钥、Catalog、额度和审计数据。这是自动清理阈值，并非强制磁盘配额；降低上限并保存可能立即删除旧记录。</p>
      <Button disabled={busy || !Number.isInteger(Number(limit)) || Number(limit) < 64 || Number(limit) > 10240} onClick={() => run(async () => { await apiFetch('/api/runtime/storage', { method: 'PUT', body: JSON.stringify({ limitMiB: Number(limit) }) }); await load(); setNotice('已保存存储策略。') })}>保存并应用</Button>
      {data.storage.lastCleanup && <p className="text-xs">本实例最近清理：{new Date(data.storage.lastCleanup.at).toLocaleString()}，删除日志 {data.storage.lastCleanup.logs} 条、对话 {data.storage.lastCleanup.conversations} 条。</p>}
      <p>Analytics Engine：{data.analyticsEnabled ? '已绑定' : '未绑定'}；已提交 {data.emitted}，提交异常 {data.failed}</p>
      <p>SQL 读取 {totals?.read.toLocaleString()} 行，写入 {totals?.written.toLocaleString()} 行</p>
      <p className="text-xs text-muted-foreground">上述运行计数自 {new Date(data.startedAt).toLocaleString()} 起，实例重建后归零，不是 Cloudflare 账单数据。</p>
      <details><summary className="cursor-pointer">SQL 来源明细</summary><div className="max-h-48 overflow-auto"><table className="w-full text-xs"><thead><tr><th>来源</th><th>调用</th><th>读取</th><th>写入</th></tr></thead><tbody>{data.sql.map(r => <tr key={r.source}><td>{r.source}</td><td>{r.calls}</td><td>{r.read}</td><td>{r.written}</td></tr>)}</tbody></table></div></details>
      <p className="text-xs">Catalog 自动检查：每 {data.catalogSchedule.intervalHours} 小时；最近执行：{data.catalogSchedule.lastRunMs ? new Date(data.catalogSchedule.lastRunMs).toLocaleString() : '等待首次执行'}</p>
    </>}
  </section>
}
