import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import type { Platform } from '../../../../shared/types'
import { PLATFORMS } from './shared'

export function useProviderOptions() {
  const { data } = useQuery<{ providers: { platform: string; name: string; signupUrl?: string; keyless: boolean }[] }>({
    queryKey: ['keys-providers'], queryFn: () => apiFetch('/api/keys/providers'),
    staleTime: 0, // refetch on opening the form / window focus after an external MCP registration
  })
  return useMemo(() => [...PLATFORMS, ...(data?.providers ?? []).filter(p => p.platform !== 'custom' && !PLATFORMS.some(b => b.value === p.platform)).map(p => ({ value: p.platform as Platform, label: p.name, url: p.signupUrl ?? '', keyless: p.keyless }))], [data])
}
