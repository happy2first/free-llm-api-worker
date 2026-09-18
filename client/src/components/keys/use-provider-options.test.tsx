// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useProviderOptions } from './use-provider-options'
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn().mockResolvedValue({ providers: [{ platform: 'managed-test', name: 'Managed Test', signupUrl: 'https://example.com/keys', keyless: false }, { platform: 'siliconflow-cn', name: 'stale managed SiliconFlow CN', signupUrl: '', keyless: false }] }) }))
it('includes registered providers in the same options used by key forms and lists', async () => {
  function Options() { const providers = useProviderOptions(); return <>{providers.map(p => <span key={p.value}>{p.label}</span>)}</> }
  const container = document.createElement('div'), root = createRoot(container), client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><Options /></QueryClientProvider>))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
    expect(container.textContent).toContain('Managed Test')
    expect(container.textContent).toContain('Google AI Studio')
    expect(container.textContent).toContain('SiliconFlow Global (.com)')
    expect(container.textContent).toContain('SiliconFlow China (.cn)')
    expect(container.textContent).not.toContain('stale managed SiliconFlow CN')
  } finally { await act(async () => root.unmount()); client.clear() }
})
