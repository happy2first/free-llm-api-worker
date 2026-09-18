import { getDb } from '../db/index.js';
import { listCatalog } from '../services/catalog-management.js';
import { listManagedProviders, readManagedProvider, registerManagedProvider, ProviderManagementError } from '../services/provider-management.js';

function catalogSummary(platform: string) {
  const records = listCatalog({ platform });
  const byKind = { chat: 0, embedding: 0, media: 0, quirk: 0 };
  const media = { image: 0, audio: 0, video: 0, transcription: 0 };
  const sources: Record<string, number> = {};
  for (const r of records) {
    byKind[r.kind]++;
    sources[r.source] = (sources[r.source] ?? 0) + 1;
    if (r.kind === 'media') {
      const modality = String(r.values.modality ?? '') as keyof typeof media;
      if (Object.hasOwn(media, modality)) media[modality]++;
    }
  }
  const keyRow = getDb().prepare(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled FROM api_keys WHERE platform = ?",
  ).get(platform) as { total: number; enabled: number | null };
  return {
    total: records.length,
    byKind,
    media,
    sources,
    keys: { total: Number(keyRow.total ?? 0), enabled: Number(keyRow.enabled ?? 0) },
  };
}

function associationFor(platform: string) {
  const provider = readManagedProvider(platform);
  const catalog = catalogSummary(platform);
  const warnings: string[] = [];
  if (!provider) warnings.push('catalog_platform_not_registered');
  if (provider && catalog.total === 0) warnings.push('provider_has_no_catalog_records');
  if (catalog.keys.total > 0 && catalog.byKind.chat === 0) warnings.push('keyed_provider_has_no_chat_catalog');
  return { platform, provider, catalog, warnings };
}

function associationAudit(platform?: string) {
  if (platform) return associationFor(platform);
  const providers = listManagedProviders();
  const platforms = new Set(providers.map(p => p.platform));
  for (const r of listCatalog()) if (r.platform) platforms.add(r.platform);
  return {
    associations: [...platforms].sort().map(associationFor),
  };
}

// Provider and Catalog are separate stores, but MCP must maintain them as one
// operational unit. Provider registration configures transport only; it is not
// complete until verified model/capability records are present in Catalog.
export const providerTools = [
  {
    name: 'provider_list',
    description: 'List registered providers together with their linked Catalog/key summary. Built-ins are read-only. A provider with zero Catalog records is incomplete for routing even if a key can be stored.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'provider_read',
    description: 'Read provider configuration, revision, and linked Catalog/key summary; does not return credentials.',
    inputSchema: { type: 'object', properties: { platform: { type: 'string' } }, required: ['platform'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'provider_catalog_status',
    description: 'Audit Provider↔Catalog association. Use after provider_register and after Catalog changes. Reports provider-without-catalog, keyed-provider-without-chat-catalog, and catalog-platform-without-provider mismatches. Omit platform to audit all.',
    inputSchema: { type: 'object', properties: { platform: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'provider_register',
    description: 'Register or update an OpenAI-compatible HTTPS CHAT provider transport. IMPORTANT: this does NOT create Catalog models. For every new provider, the MCP maintenance workflow is incomplete until you (1) verify provider documentation/model capabilities, (2) call provider_catalog_status, (3) create/update ALL verified Catalog records for that same platform using catalog_* tools, including media/embedding only when the runtime has the required adapter, and (4) call provider_catalog_status again. Never stop after provider_register merely because the provider appears in the Keys picker. The user supplies secrets in Keys; never accept API secrets here. baseUrl must include the API prefix (e.g. /v1), not /chat/completions. Conflicts require replace + expectedRevision or skip. Built-ins cannot be overwritten; endpoints cannot change while credentials exist.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,63}$' },
        name: { type: 'string' },
        protocol: { type: 'string', enum: ['openai-compatible'] },
        baseUrl: { type: 'string' },
        signupUrl: { type: 'string' },
        conflict: { type: 'string', enum: ['replace','skip'] },
        expectedRevision: { type: 'string' },
      },
      required: ['platform','name','protocol','baseUrl'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
];

export async function callProviderTool(name: string, input: Record<string, unknown>) {
  if (name === 'provider_list') {
    return {
      providers: listManagedProviders().map(p => ({ ...p, association: catalogSummary(p.platform) })),
      maintenance: 'Provider registration and Catalog population are separate writes but one MCP workflow. Audit with provider_catalog_status.',
    };
  }
  if (name === 'provider_read') {
    if (typeof input.platform !== 'string') throw new ProviderManagementError(400, 'platform is required');
    return associationFor(input.platform);
  }
  if (name === 'provider_catalog_status') {
    if (input.platform !== undefined && typeof input.platform !== 'string') throw new ProviderManagementError(400, 'platform must be a string');
    return associationAudit(input.platform as string | undefined);
  }
  if (name === 'provider_register') {
    const result = await registerManagedProvider(input);
    const platform = (result as any)?.provider?.platform ?? input.platform;
    return {
      ...result,
      association: typeof platform === 'string' ? associationFor(platform) : null,
      nextAction: 'Verify and maintain Catalog records for this platform with catalog_* tools, then call provider_catalog_status again. Registration alone is not a complete provider integration.',
    };
  }
  throw new ProviderManagementError(400, 'Unknown provider tool');
}
