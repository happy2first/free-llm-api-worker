import { listManagedProviders, readManagedProvider, registerManagedProvider, ProviderManagementError } from '../services/provider-management.js';

// Independent Provider tools share the administrator-authenticated MCP transport,
// not the Catalog data model. Never accept API secrets here.
export const providerTools = [
  { name: 'provider_list', description: 'List registered providers. Built-ins are read-only. Register a provider before adding its models to Catalog.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'provider_read', description: 'Read provider configuration and revision; does not return credentials.', inputSchema: { type: 'object', properties: { platform: { type: 'string' } }, required: ['platform'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'provider_register', description: 'Persist a new OpenAI-compatible HTTPS CHAT provider independently of Catalog. Embedding/media and non-OpenAI protocols require dedicated adapters and are not enabled by registration. It appears in the Keys picker immediately; the user supplies secrets there. baseUrl must include the API prefix (e.g. /v1), not /chat/completions. No custom code/headers or special protocols. Verify provider documentation before registering. Conflicts return existing configuration: explicitly use replace + expectedRevision or skip. Built-ins cannot be overwritten; endpoints cannot change while credentials exist.', inputSchema: { type: 'object', properties: { platform: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,63}$' }, name: { type: 'string' }, protocol: { type: 'string', enum: ['openai-compatible'] }, baseUrl: { type: 'string' }, signupUrl: { type: 'string' }, conflict: { type: 'string', enum: ['replace','skip'] }, expectedRevision: { type: 'string' } }, required: ['platform','name','protocol','baseUrl'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
];
export async function callProviderTool(name: string, input: Record<string, unknown>) {
  if (name === 'provider_list') return { providers: listManagedProviders() };
  if (name === 'provider_read') {
    if (typeof input.platform !== 'string') throw new ProviderManagementError(400, 'platform is required');
    return { provider: readManagedProvider(input.platform) };
  }
  if (name === 'provider_register') return registerManagedProvider(input);
  throw new ProviderManagementError(400, 'Unknown provider tool');
}
