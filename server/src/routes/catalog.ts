import { providerTools, callProviderTool } from './provider-mcp.js';
import { ProviderManagementError } from '../services/provider-management.js';
import { Router } from 'express';
import { CatalogError, catalogStatus, checkCatalogUpdates, listCatalog, mutateCatalog, readCatalog } from '../services/catalog-management.js';
export const catalogRouter = Router();
function failure(res: any, error: unknown) {
  const e = error instanceof CatalogError ? error : new CatalogError(500, 'Catalog operation failed');
  if (!(error instanceof CatalogError)) console.error('[catalog]', error);
  res.status(e.status).json({ error: { type: e.status === 409 ? 'catalog_conflict' : 'catalog_error', message: e.message }, existing: e.existing, proposed: e.proposed });
}
catalogRouter.get('/', (req, res) => { try { res.json({ records: listCatalog(req.query), status: catalogStatus() }); } catch (e) { failure(res, e); } });
catalogRouter.post('/sync', async (_req, res) => { try { res.json(await checkCatalogUpdates()); } catch (e) { failure(res, e); } });
catalogRouter.post('/records/:action', (req, res) => {
  try { res.json(mutateCatalog(req.params.action as any, req.body, 'user')); } catch (e) { failure(res, e); }
});
const identitySchema = { kind: { type: 'string', enum: ['chat','embedding','media','quirk'] }, platform: { type: 'string' }, modelId: { type: 'string' } };
const tools = ['search','read','create','update','delete','restore'].map(action => ({
  name: `catalog_${action}`,
  description: action === 'search' ? 'Search the unified catalog, including source and free-tier evidence.' : `Catalog ${action}. Provider and Catalog are separate stores but one integration: for non-quirk records the platform must already be a registered provider. After provider_register, maintain every verified model/capability record for that exact platform and verify with provider_catalog_status. Existing records require conflict=replace AND expectedRevision from read/conflict, or conflict=skip. Writes are owned by ai. Never automatically resolve a conflict. Values use the database field names returned by read.`,
  inputSchema: { type: 'object', properties: action === 'search' ? { search: { type: 'string' }, kind: identitySchema.kind, platform: { type: 'string' }, source: { type: 'string', enum: ['freellm','user','ai'] }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } } : { ...identitySchema, values: { type: 'object' }, extensions: { type: 'object', description: 'credentialRequirement, freeQuota, requiresCreditCard, requiresPhone, requiresKyc, signupUrl, regions, notes, evidenceLinks' }, origin: { type: 'string' }, conflict: { type: 'string', enum: ['replace','skip'] }, expectedRevision: { type: 'string' } }, required: action === 'search' ? [] : ['kind','platform','modelId'], additionalProperties: false },
  annotations: { readOnlyHint: ['search','read'].includes(action), destructiveHint: !['search','read'].includes(action), openWorldHint: false },
}));
// Stateless Streamable HTTP MCP; same administrator authentication as /api/catalog.
// This endpoint is NEVER reachable with a downstream application API key alone.
catalogRouter.get('/mcp', (_req, res) => { res.set('Allow', 'POST').status(405).end(); });
catalogRouter.post('/mcp', async (req, res) => {
  const msg = req.body;
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || Array.isArray(msg)) { res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); return; }
  if (!Object.hasOwn(msg, 'id')) { res.status(202).end(); return; }
  const reply = (result: unknown) => res.json({ jsonrpc: '2.0', id: msg.id, result });
  if (msg.method === 'initialize') { reply({ protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'freellm-catalog', version: '1.0.0' }, instructions: 'Provider and Catalog are separate stores but must be maintained as one integration. For a new platform: provider_register -> provider_catalog_status -> verify documentation/capabilities -> catalog_create/update every verified record for the same platform -> provider_catalog_status again. Do not stop after provider_register. Do not create Catalog rows for an unregistered provider or for media/embedding capabilities without runtime adapter support.' }); return; }
  if (msg.method === 'ping') { reply({}); return; }
  if (msg.method === 'tools/list') { reply({ tools: [...tools, ...providerTools] }); return; }
  if (msg.method !== 'tools/call') { res.json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }); return; }
  const action = String(msg.params?.name ?? '').replace(/^catalog_/, '');
  try {
    if (![...tools, ...providerTools].some(t => t.name === msg.params?.name)) throw new CatalogError(400, 'Unknown tool');
    const input = msg.params.arguments ?? {};
    if (!input || Array.isArray(input) || typeof input !== 'object') throw new CatalogError(400, 'arguments must be an object');
    let result: unknown;
    if (providerTools.some(t => t.name === msg.params.name)) result = await callProviderTool(msg.params.name, input);
    else if (action === 'search') {
      const all = listCatalog(input);
      const offset = Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
      const limit = Number.isInteger(input.limit) ? Math.max(1, Math.min(100, input.limit)) : 50;
      result = { records: all.slice(offset, offset + limit), total: all.length, nextOffset: offset + limit < all.length ? offset + limit : null };
    } else if (action === 'read') result = readCatalog(input);
    else result = mutateCatalog(action as any, input, 'ai');
    reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
  } catch (e) {
    const error = e instanceof CatalogError || e instanceof ProviderManagementError ? e : new CatalogError(500, 'Catalog operation failed');
    reply({ isError: true, content: [{ type: 'text', text: JSON.stringify({ status: error.status, message: error.message, existing: error.existing, proposed: error instanceof CatalogError ? error.proposed : undefined }) }] });
  }
});
