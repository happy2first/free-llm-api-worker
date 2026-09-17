import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'

/** Same base path as apiFetch; never persist a deployment-specific hostname. */
export function mcpAddress(path: string) {
  return new URL(`${import.meta.env.BASE_URL.replace(/\/$/, '')}${path}`, window.location.origin).href
}

export function McpConnectionSettings() {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => { pending.current?.abort() }, [])
  const catalog = mcpAddress('/api/catalog/mcp')
  const gateway = mcpAddress('/mcp')
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setMessage('地址已复制') }
    catch { setMessage('复制失败，请选中上方地址手动复制。') }
  }
  const test = async () => {
    if (pending.current) return
    const controller = new AbortController()
    pending.current = controller
    setBusy(true); setMessage('正在测试…')
    const timeout = window.setTimeout(() => controller.abort(), 15000)
    try {
      const call = async (method: string, id: number, params?: object) => {
        const result = await apiFetch<{ result?: { protocolVersion?: string; tools?: { name: string }[] }; error?: { message: string } }>('/api/catalog/mcp', {
          method: 'POST', signal: controller.signal, redirect: 'error',
          headers: { Accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        })
        if (result.error || !result.result) throw new Error(result.error?.message ?? '响应不是有效的 MCP JSON-RPC 结果')
        return result.result
      }
      const init = await call('initialize', 1, { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'settings-connection-test', version: '1.0' } })
      const listed = await call('tools/list', 2)
      if (!init.protocolVersion || !Array.isArray(listed.tools)) throw new Error('MCP 握手或工具列表不完整')
      setMessage(`连接成功：协议 ${init.protocolVersion}，${listed.tools.length} 个工具。已验证当前浏览器管理会话；外部客户端仍需独立认证。`)
    } catch (error) {
      setMessage(`测试失败：${controller.signal.aborted ? '请求超时或已取消' : (error as Error).message}。请确认当前域名部署完成并重新登录 Access；登录重定向不能作为 MCP 响应。`)
    } finally {
      window.clearTimeout(timeout)
      pending.current = null
      setBusy(false)
    }
  }
  return <section className="space-y-3 rounded-xl border p-4">
    <h3 className="font-semibold">本系统 MCP 接入</h3>
    <p className="text-sm text-muted-foreground">地址根据当前浏览器域名生成。传输方式：Streamable HTTP（JSON-RPC POST）。浏览器直接打开地址可能返回 405，请使用下方连接测试。</p>
    <div className="space-y-2 text-sm"><strong>Catalog 目录管理 MCP</strong><code className="block select-all break-all rounded bg-muted p-2">{catalog}</code>
      <div className="flex gap-2"><Button variant="outline" onClick={() => copy(catalog)}>复制目录 MCP 地址</Button><Button disabled={busy} onClick={test}>{busy ? '测试中…' : '测试目录 MCP 连接'}</Button></div>
      <p>支持目录管理与独立 Provider 注册（provider_list / provider_read / provider_register）。新平台先注册，再添加 Catalog 模型及密钥。测试只执行 initialize 和 tools/list，不修改目录。</p>
    </div>
    <details className="space-y-2 text-sm"><summary>网关 MCP（模型、健康与路由）</summary><code className="block select-all break-all rounded bg-muted p-2">{gateway}</code><Button variant="outline" onClick={() => copy(gateway)}>复制网关 MCP 地址</Button><p>先在“密钥 → 智能体兼容”启用 MCP，再使用统一 API 密钥作为 Authorization: Bearer 凭证；Cloudflare 部署还需要通过外层 Access。</p></details>
    <details className="space-y-2 text-sm"><summary>客户端接入与排错说明</summary>
      <ol className="list-decimal space-y-2 pl-5"><li>在支持 Streamable HTTP 的 MCP 客户端中新增远程服务器，按用途粘贴上述地址。</li><li>Catalog 使用管理员身份认证，下游统一 API 密钥不能管理目录。Cloudflare Access 部署需要客户端可用的 Access 认证或受控认证网关；本系统尚未提供供 ChatGPT 自动登录的 OAuth 流程。仅粘贴 URL 不保证能接入 ChatGPT。</li><li>先执行 initialize，再读取 tools/list。401/403 表示认证或启用状态问题；302 或 HTML 表示跳转了登录页；405 通常表示使用了 GET，应改为 POST。</li><li>不要公开放行目录管理路径。AI 写入来源为 ai；冲突需要读取现有 revision 后明确选择 replace 或 skip，官方同步不会覆盖 user / ai 数据。</li></ol>
    </details>
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>
}
