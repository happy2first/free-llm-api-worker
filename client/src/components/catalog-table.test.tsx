// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { CatalogTable, compareCatalogValues, matchesCatalogFilter, type CatalogRecord } from './catalog-table'
const row = (platform: string, n: number): CatalogRecord => ({ kind: 'chat', platform, modelId: `model-${n}`, source: 'ai', origin: null, extensions: {}, values: { enabled: 1, context_window: n }, revision: String(n), updatedAt: n })
it('sorts numeric values with unknown values last and supports numeric bounds', () => {
  expect([128000, null, 9000].sort((a,b) => compareCatalogValues(a,b,false))).toEqual([9000,128000,null])
  expect([128000, null, 9000].sort((a,b) => compareCatalogValues(a,b,true))).toEqual([128000,9000,null])
  expect(matchesCatalogFilter(128000, '>=32000', true)).toBe(true)
  expect(matchesCatalogFilter(9000, '>=32000', true)).toBe(false)
  expect(matchesCatalogFilter(null, '>=0', true)).toBe(false)
})
it('puts edit first, opens filters on demand and keeps sorting independent', async () => {
  const container = document.createElement('div'), root = createRoot(container)
  try {
    await act(async () => root.render(<CatalogTable records={[row('test',9),row('test-cn',128)]} busy={false} onEdit={() => {}} />))
    expect(container.querySelector('thead th')!.textContent).toContain('操作')
    expect(container.querySelector('tbody td button')!.textContent).toBe('编辑')
    expect(container.querySelector('[aria-label="筛选Provider"]')).toBeNull()
    const openProvider = container.querySelector('[aria-label="打开Provider筛选"]') as HTMLButtonElement
    await act(async () => openProvider.click())
    const provider = container.querySelector('[aria-label="筛选Provider"]') as HTMLSelectElement
    expect(provider).not.toBeNull()
    await act(async () => { provider.value = 'test'; provider.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.querySelector('tbody')!.textContent).toContain('model-9')
    expect(container.querySelector('tbody')!.textContent).not.toContain('model-128')
    await act(async () => { provider.value = ''; provider.dispatchEvent(new Event('change', { bubbles: true })) })
    const sort = container.querySelector('[aria-label="排序上下文"]') as HTMLButtonElement
    await act(async () => sort.click())
    expect(container.querySelector('tbody tr')!.textContent).toContain('model-9')
    await act(async () => sort.click())
    expect(container.querySelector('tbody tr')!.textContent).toContain('model-128')
  } finally { await act(async () => root.unmount()) }
})
it('allows changing the number of rows shown per page', async () => {
  const container = document.createElement('div'), root = createRoot(container)
  try {
    const records = Array.from({ length: 30 }, (_, i) => row('test', i + 1))
    await act(async () => root.render(<CatalogTable records={records} busy={false} onEdit={() => {}} />))
    expect(container.querySelectorAll('tbody tr')).toHaveLength(25)
    const pageSize = container.querySelector('[aria-label="每页条数"]') as HTMLSelectElement
    await act(async () => { pageSize.value = '50'; pageSize.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.querySelectorAll('tbody tr')).toHaveLength(30)
  } finally { await act(async () => root.unmount()) }
})
