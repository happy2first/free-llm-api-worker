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
  return <section className="space-y-4 rounded-xl border p-5 text-sm">
    <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">Cloudflare 资源统计</h3><Button size="sm" variant="outline" disabled={busy} onClick={() => run(load)}>刷新</Button></div>
    <p className="text-xs text-muted-foreground">当前 Gateway 实例 · 运行计数重启后归零，不代表账户账单额度。</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!data && !error && <p className="py-6 text-muted-foreground">正在读取资源统计…</p>}
    {data && <>
      <dl className="divide-y rounded-lg border px-4">{[
        ['有效存储', `${mib(data.storage.usedBytes)} MiB`],
        ['清理阈值', `${data.storage.limitMiB} MiB`],
        ['SQL 读取行数', totals?.read.toLocaleString()],
        ['SQL 写入行数', totals?.written.toLocaleString()],
        ['Analytics Engine', data.analyticsEnabled ? '已绑定' : '未绑定'],
        ['分析事件提交 / 异常', `${data.emitted} / ${data.failed}`],
        ['本实例启动时间', new Date(data.startedAt).toLocaleString()],
        ['Catalog 自动检查', `每 ${data.catalogSchedule.intervalHours} 小时`],
        ['最近自动检查', data.catalogSchedule.lastRunMs ? new Date(data.catalogSchedule.lastRunMs).toLocaleString() : '尚未执行'],
      ].map(([label,value]) => <div className="flex flex-wrap justify-between gap-2 py-3" key={label}><dt className="text-muted-foreground">{label}</dt><dd className="font-medium tabular-nums">{value}</dd></div>)}</dl>
      {data.storage.overLimit && <p role="alert" className="text-amber-600">存储超过清理阈值，核心数据及近期对话会保留。</p>}
      <h4 className="font-medium">SQL 来源明细</h4><div className="max-h-72 overflow-auto rounded-lg border"><table className="w-full text-left text-xs"><thead className="sticky top-0 bg-muted"><tr>{['来源','调用次数','读取行数','写入行数'].map(h => <th className="p-3" key={h}>{h}</th>)}</tr></thead><tbody>{data.sql.map(r => <tr className="border-t" key={r.source}><td className="p-3 break-all">{r.source}</td><td className="p-3">{r.calls.toLocaleString()}</td><td className="p-3">{r.read.toLocaleString()}</td><td className="p-3">{r.written.toLocaleString()}</td></tr>)}{!data.sql.length && <tr><td colSpan={4} className="p-6 text-center text-muted-foreground">暂无 SQL 统计</td></tr>}</tbody></table></div>
      <details className="rounded-lg border p-4"><summary className="cursor-pointer font-medium">存储清理设置</summary><div className="mt-4 space-y-3">
        <label className="block space-y-1">清理阈值（MiB）<Input aria-label="存储清理上限" type="number" min="64" max="10240" step="1" value={limit} onChange={e => setLimit(e.target.value)} /></label>
        <p className="text-xs text-muted-foreground">默认 768 MiB。每 5 分钟检查，清理最旧日志与对话，保留最近 1 小时对话及核心数据。降低阈值并保存可能立即删除旧记录；此阈值并非硬性磁盘配额。</p>
        <Button disabled={busy || !Number.isInteger(Number(limit)) || Number(limit) < 64 || Number(limit) > 10240} onClick={() => run(async () => { await apiFetch('/api/runtime/storage', { method: 'PUT', body: JSON.stringify({ limitMiB: Number(limit) }) }); await load(); setNotice('已保存存储策略。') })}>保存并应用</Button>
        {data.storage.lastCleanup && <p className="text-xs">最近清理：{new Date(data.storage.lastCleanup.at).toLocaleString()} · 日志 {data.storage.lastCleanup.logs} 条 · 对话 {data.storage.lastCleanup.conversations} 条</p>}
      </div></details>
    </>}
  </section>
}
