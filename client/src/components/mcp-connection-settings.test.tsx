// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { McpConnectionSettings, mcpAddress } from './mcp-connection-settings'
import { apiFetch } from '@/lib/api'
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
afterEach(() => vi.clearAllMocks())
it('uses the browser origin and verifies initialize plus tools/list without writes', async () => {
  expect(mcpAddress('/api/catalog/mcp')).toBe(`${window.location.origin}/api/catalog/mcp`)
  vi.mocked(apiFetch).mockResolvedValueOnce({ result: { protocolVersion: '2025-03-26' } }).mockResolvedValueOnce({ result: { tools: [{ name: 'catalog_read' }] } })
  const container = document.createElement('div'), root = createRoot(container)
  try {
    await act(async () => root.render(<McpConnectionSettings />))
    const button = [...container.querySelectorAll('button')].find(b => b.textContent === '测试目录 MCP 连接')!
    await act(async () => button.click())
    expect(container.textContent).toContain('连接成功')
    expect(vi.mocked(apiFetch).mock.calls.map(([, options]) => JSON.parse(String(options?.body)).method)).toEqual(['initialize', 'tools/list'])
    expect(vi.mocked(apiFetch).mock.calls[0][1]?.redirect).toBe('error')
  } finally { await act(async () => root.unmount()) }
})
it('does not report JSON-RPC authentication errors as a successful connection', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ error: { message: 'Unauthorized' } })
  const container = document.createElement('div'), root = createRoot(container)
  try {
    await act(async () => root.render(<McpConnectionSettings />))
    await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === '测试目录 MCP 连接')!.click())
    expect(container.textContent).toContain('测试失败：Unauthorized')
    expect(apiFetch).toHaveBeenCalledTimes(1)
  } finally { await act(async () => root.unmount()) }
})
