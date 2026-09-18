import { parseModelScope, scopeAllows } from '../lib/model-scope.js';
import { recordCatalogModelTombstone } from './model-state.js';
import { createHash } from 'node:crypto';
import { getDb, getSetting } from '../db/index.js';
import { catalogTables, identity, type CatalogKind } from './catalog-ownership.js';
import { getSyncState, syncCatalog, routableContextWindow } from './catalog-sync.js';
import { ensureAllModelsInProfiles } from './profile-models.js';
import { hasProvider } from '../providers/index.js';
import { MEDIA_PLATFORMS, TRANSCRIPTION_PLATFORMS, VIDEO_PLATFORMS } from './media.js';
import { EMBEDDING_PLATFORMS } from './embeddings.js';
import type { Platform } from '@freellmapi/shared/types.js';

export class CatalogError extends Error {
  constructor(public status: number, message: string, public existing?: unknown, public proposed?: unknown) { super(message); }
}
type Row = Record<string, any>;
export interface CatalogRecord {
  kind: CatalogKind; platform: string; modelId: string; source: 'freellm' | 'user' | 'ai';
  values: Row; origin: string | null; extensions: Row; revision: string; updatedAt: number | null; readOnly?: boolean; integration?: { connected: boolean; reason: string };
}
const fields: Record<CatalogKind, string[]> = {
  chat: ['display_name','intelligence_rank','speed_rank','size_label','rpm_limit','rpd_limit','tpm_limit','tpd_limit','monthly_token_budget','context_window','enabled','supports_vision','supports_tools'],
  embedding: ['family','display_name','dimensions','max_input_tokens','priority','enabled','quota_label'],
  media: ['display_name','modality','priority','enabled','quota_label','meta_json'],
  quirk: ['title','body','severity'],
};
function parse(raw: string | null | undefined, fallback: any = {}) { try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } }
function checkIdentity(input: Row): CatalogKind {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CatalogError(400, 'Record must be an object');
  if (!Object.hasOwn(catalogTables, input.kind)) throw new CatalogError(400, 'kind must be chat, embedding, media or quirk');
  if (typeof input.modelId !== 'string' || !input.modelId.trim() || input.modelId.length > 512) throw new CatalogError(400, 'modelId is required (max 512 characters)');
  if (typeof input.platform !== 'string' || input.platform.length > 100 || (input.kind !== 'quirk' && !input.platform.trim()) || (input.kind === 'quirk' && input.platform !== '')) throw new CatalogError(400, 'platform is required; quirks use an empty platform');
  return input.kind;
}
function where(kind: CatalogKind): string { return kind === 'quirk' ? 'slug = ?' : 'platform = ? AND model_id = ?'; }
function args(kind: CatalogKind, platform: string, modelId: string) { return kind === 'quirk' ? [modelId] : [platform, modelId]; }
function annotation(kind: CatalogKind, platform: string, modelId: string): Row | undefined {
  return getDb().prepare('SELECT * FROM catalog_annotations WHERE kind = ? AND platform = ? AND model_id = ?').get(kind, platform, modelId) as Row | undefined;
}
function record(kind: CatalogKind, row: Row, notes?: Row): CatalogRecord {
  const platform = kind === 'quirk' ? '' : row.platform;
  const modelId = kind === 'quirk' ? row.slug : row.model_id;
  const values = Object.fromEntries(fields[kind].map(field => [field, row[field] ?? null]));
  if (kind === 'quirk') values.targets = getDb().prepare('SELECT platform, model_glob FROM quirk_targets WHERE quirk_id = ? ORDER BY id').all(row.id);
  const value = { kind, platform, modelId, source: row.source === 'user' || row.source === 'ai' ? row.source : 'freellm', values, origin: notes?.origin ?? null, extensions: parse(notes?.extensions_json), readOnly: row.key_id != null } as Omit<CatalogRecord, 'revision' | 'updatedAt'>;
  return { ...value, updatedAt: notes?.updated_at_ms ?? row.updated_at_ms ?? null, revision: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
}
export function readCatalog(input: Row): CatalogRecord | null {
  const kind = checkIdentity(input);
  const rows = getDb().prepare(`SELECT * FROM ${catalogTables[kind]} WHERE ${where(kind)}`).all(...args(kind, input.platform, input.modelId)) as Row[];
  if (rows.length > 1) throw new CatalogError(409, 'Multiple endpoint-scoped records: manage these through the existing Provider page', rows.map(r => record(kind, r)));
  return rows[0] ? record(kind, rows[0], annotation(kind, input.platform, input.modelId)) : null;
}
export function listCatalog(query: Row = {}): CatalogRecord[] {
  if (query.kind && !Object.hasOwn(catalogTables, query.kind)) throw new CatalogError(400, 'Unknown catalog kind');
  const db = getDb();
  // Read credential metadata once, never secrets or one SQL query per model.
  const keys = (db.prepare('SELECT id, platform, enabled, status, model_scope_json FROM api_keys').all() as { id: number; platform: string; enabled: number; status: string; model_scope_json: string | null }[]).map(k => ({ ...k, scope: parseModelScope(k.model_scope_json) }));
  const notes = new Map((db.prepare('SELECT * FROM catalog_annotations').all() as Row[]).map(r => [identity(r.kind, r.platform, r.model_id), r]));
  const rows: CatalogRecord[] = [];
  for (const kind of Object.keys(catalogTables) as CatalogKind[]) {
    if (query.kind && query.kind !== kind) continue;
    for (const row of db.prepare(`SELECT * FROM ${catalogTables[kind]}`).all() as Row[]) {
      const platform = kind === 'quirk' ? '' : row.platform;
      const modelId = kind === 'quirk' ? row.slug : row.model_id;
      if (query.platform && platform !== query.platform) continue;
      const r = record(kind, row, notes.get(identity(kind, platform, modelId)));
      if (query.source && r.source !== query.source) continue;
      if (query.search && !JSON.stringify(r).toLowerCase().includes(String(query.search).toLowerCase())) continue;
      if (kind !== 'quirk') {
        const matching = keys.filter(k => k.platform === platform && (row.key_id == null || row.key_id === k.id) && scopeAllows(k.scope, modelId));
        const enabled = matching.filter(k => k.enabled === 1);
        // Configuration status, not a quota/cooldown probe or a promise of successful inference.
        r.integration = { connected: row.enabled === 1 && enabled.some(k => ['healthy', 'unknown'].includes(k.status)),
          reason: row.enabled !== 1 ? '模型未启用' : !matching.length ? '未配置匹配凭证' : !enabled.length ? '凭证未启用' : !enabled.some(k => ['healthy', 'unknown'].includes(k.status)) ? '凭证状态异常' : '已接入（未实时测试）' };
      }
      rows.push(r);
    }
  }
  return rows;
}
export function catalogStatus() {
  const official = parse(getSetting('catalog_applied_json'), null);
  return { ...getSyncState(), lastSyncMs: Number(getSetting('catalog_last_check_ms')) || getSyncState().lastSyncMs, generatedAt: official?.generatedAt ?? null, official,
    autoSync: { intervalHours: 12, enabled: process.env.CATALOG_SYNC_DISABLED !== '1' },
    providersWithoutChatModels: (getDb().prepare("SELECT DISTINCT k.platform FROM api_keys k WHERE NOT EXISTS (SELECT 1 FROM models m WHERE m.platform = k.platform AND m.enabled = 1)").all() as { platform: string }[]).map(r => r.platform),
    history: getDb().prepare('SELECT * FROM catalog_history ORDER BY id DESC LIMIT 20').all(),
    extensions: ['credentialRequirement','freeQuota','requiresCreditCard','requiresPhone','requiresKyc','signupUrl','regions','notes','evidenceLinks'],
  };
}
function audit(action: string, detail: Row) {
  const db = getDb();
  db.prepare('INSERT INTO catalog_history(at_ms, action, detail_json) VALUES (?, ?, ?)').run(Date.now(), action, JSON.stringify(detail));
  db.prepare('DELETE FROM catalog_history WHERE id NOT IN (SELECT id FROM catalog_history ORDER BY id DESC LIMIT 100)').run();
}
function validate(kind: CatalogKind, values: Row) {
  if (!values || Array.isArray(values) || typeof values !== 'object') throw new CatalogError(400, 'values must be an object');
  for (const [key, value] of Object.entries(values)) {
    if (!fields[kind].includes(key) && !(kind === 'quirk' && key === 'targets')) throw new CatalogError(400, `Unsupported field: ${key}`);
    if (key === 'targets') {
      if (!Array.isArray(value) || value.length > 100 || value.some(t => !t || typeof t !== 'object' || ![t.platform,t.model_glob].every(v => v === null || typeof v === 'string'))) throw new CatalogError(400, 'targets must contain platform/model_glob strings or nulls');
    } else if (['enabled','supports_vision','supports_tools'].includes(key)) {
      if (value !== 0 && value !== 1) throw new CatalogError(400, `${key} must be 0 or 1`);
    } else if (['intelligence_rank','speed_rank','rpm_limit','rpd_limit','tpm_limit','tpd_limit','context_window','dimensions','max_input_tokens','priority'].includes(key)) {
      if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new CatalogError(400, `${key} must be a nonnegative integer or null`);
    } else if (value !== null && (typeof value !== 'string' || value.length > 20000)) throw new CatalogError(400, `${key} must be text (max 20000 characters)`);
  }
  if (kind === 'chat' && (!Number.isSafeInteger(values.intelligence_rank) || !Number.isSafeInteger(values.speed_rank) || typeof values.monthly_token_budget !== 'string' || typeof values.size_label !== 'string')) throw new CatalogError(400, 'Chat ranks must be integers; budget and size_label must be text');
  if (kind !== 'quirk' && !values.display_name?.trim()) throw new CatalogError(400, 'display_name is required');
  if (kind === 'embedding' && (!values.family?.trim() || !Number.isSafeInteger(values.dimensions) || values.dimensions < 1)) throw new CatalogError(400, 'family and positive dimensions are required');
  if (kind === 'media' && !['image','audio','video','transcription'].includes(values.modality)) throw new CatalogError(400, 'Invalid modality');
  if (kind === 'media' && values.meta_json != null) { try { const parsed = JSON.parse(values.meta_json); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw 0; } catch { throw new CatalogError(400, 'meta_json must encode an object'); } }
  if (kind === 'quirk' && (!values.title?.trim() || !['info','warning','blocker'].includes(values.severity))) throw new CatalogError(400, 'title and valid severity are required');
}
function defaults(kind: CatalogKind): Row {
  if (kind === 'chat') return { intelligence_rank: 0, speed_rank: 0, size_label: '', monthly_token_budget: '', enabled: 1, supports_vision: 0, supports_tools: 0 };
  if (kind === 'quirk') return { body: '', severity: 'info', targets: [] };
  return { enabled: 1, priority: 0, quota_label: '' };
}
// The cached document is written ONLY after signed sync verification. Restoration
// copies one official record; it never applies a synthetic partial catalog (which
// would prune unrelated models).
function officialValues(kind: CatalogKind, platform: string, modelId: string): Row {
  const doc = parse(getSetting('catalog_applied_json'), null);
  if (!doc) throw new CatalogError(409, 'No verified official snapshot cached; check updates first');
  const match = (m: Row) => m.platform === platform && m.modelId === modelId;
  let m: Row | undefined;
  if (kind === 'chat') m = doc.models?.find((r: Row) => match(r) && (!r.modality || r.modality === 'text'));
  if (kind === 'embedding') m = doc.embeddings?.find(match);
  if (kind === 'quirk') m = doc.quirks?.find((r: Row) => r.slug === modelId);
  if (kind === 'media') {
    m = doc.models?.find((r: Row) => match(r) && ['image','audio'].includes(r.modality));
    if (!m) { const v = doc.videoModels?.find(match); if (v) m = { ...v, modality: 'video' }; }
    if (!m) { const v = doc.transcriptionModels?.find(match); if (v) m = { ...v, modality: 'transcription' }; }
  }
  if (!m) throw new CatalogError(404, 'Record is absent from the current official snapshot');
  if (kind === 'chat') return { display_name: m.displayName, intelligence_rank: m.intelligenceRank, speed_rank: m.speedRank, size_label: m.sizeLabel, rpm_limit: m.limits.rpm, rpd_limit: m.limits.rpd, tpm_limit: m.limits.tpm, tpd_limit: m.limits.tpd, monthly_token_budget: m.monthlyTokenBudget ?? '', context_window: routableContextWindow(platform, modelId, m.contextWindow), enabled: +m.enabled, supports_vision: +m.supportsVision, supports_tools: +m.supportsTools };
  if (kind === 'embedding') return { family: m.family, display_name: m.displayName, dimensions: m.dimensions, max_input_tokens: m.maxInputTokens, priority: m.priority, enabled: +m.enabled, quota_label: m.quotaLabel ?? '' };
  if (kind === 'quirk') return { title: m.title, body: m.body, severity: m.severity, targets: m.targets.map((t: Row) => ({ platform: t.platform ?? null, model_glob: t.modelGlob ?? null })) };
  const meta = Object.fromEntries(['requestStyle','providerModelId','subtitleFormats','maxBytes'].filter(k => m![k] !== undefined).map(k => [k, m![k]]));
  return { display_name: m.displayName, modality: m.modality, priority: m.priority ?? m.intelligenceRank ?? 0, enabled: +m.enabled, quota_label: m.quotaLabel ?? m.mediaNote ?? '', meta_json: Object.keys(meta).length ? JSON.stringify(meta) : null };
}
export function mutateCatalog(action: 'create' | 'update' | 'delete' | 'restore', input: Row, owner: 'user' | 'ai') {
  const kind = checkIdentity(input);
  if (!['create','update','delete','restore'].includes(action)) throw new CatalogError(400, 'Unknown action');
  if (input.conflict !== undefined && !['replace','skip'].includes(input.conflict)) throw new CatalogError(400, 'conflict must be replace or skip');
  if (action !== 'delete' && kind !== 'quirk') {
    if (!hasProvider(input.platform as Platform)) {
      throw new CatalogError(400, `Unknown provider platform '${input.platform}'. Register the provider first, then maintain its Catalog records.`);
    }
    if (kind === 'embedding' && !EMBEDDING_PLATFORMS.has(input.platform)) {
      throw new CatalogError(400, `Provider '${input.platform}' has no embedding adapter in this runtime; do not add embedding Catalog rows until adapter support exists.`);
    }
    if (kind === 'media') {
      const modality = String(input.values?.modality ?? readCatalog(input)?.values.modality ?? '');
      const supported = modality === 'video' ? VIDEO_PLATFORMS.has(input.platform)
        : modality === 'transcription' ? TRANSCRIPTION_PLATFORMS.has(input.platform)
          : ['image','audio'].includes(modality) ? MEDIA_PLATFORMS.has(input.platform)
            : true;
      if (!supported) {
        throw new CatalogError(400, `Provider '${input.platform}' has no runtime adapter for media modality '${modality}'. Registering a provider transport does not enable media automatically.`);
      }
    }
  }
  const db = getDb();
  return db.transaction(() => {
    const existing = readCatalog(input);
    const notes = annotation(kind, input.platform, input.modelId);
    if (existing?.readOnly) throw new CatalogError(409, 'Endpoint-scoped record: use the existing Provider editor', existing);
    if (action === 'update' && !existing) throw new CatalogError(404, 'Record not found');
    const values = action === 'restore' ? officialValues(kind, input.platform, input.modelId) : { ...defaults(kind), ...existing?.values, ...input.values };
    const conflict = existing ?? (notes?.deleted_source ? { deleted: true, source: notes.deleted_source } : null);
    if (conflict && input.conflict === 'skip') return { skipped: true, record: existing };
    if (conflict && (input.conflict !== 'replace' || (existing && input.expectedRevision !== existing.revision))) throw new CatalogError(409, 'Explicit replace with expectedRevision, or skip, is required', conflict, { ...input, values });
    if (action !== 'delete') validate(kind, values);
    const source = action === 'restore' ? 'catalog' : owner;
    const condition = where(kind), params = args(kind, input.platform, input.modelId), table = catalogTables[kind];
    const row = db.prepare(`SELECT id FROM ${table} WHERE ${condition}`).get(...params) as { id: number } | undefined;
    if (action === 'delete') {
      if (kind === 'chat' || kind === 'media') recordCatalogModelTombstone(db, kind, input.platform, input.modelId);
      if (kind === 'chat' && row) db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(row.id);
      if (kind === 'quirk' && row) db.prepare('DELETE FROM quirk_targets WHERE quirk_id = ?').run(row.id);
      db.prepare(`DELETE FROM ${table} WHERE ${condition}`).run(...params);
    } else {
      const keys = fields[kind].filter(k => values[k] !== undefined);
      if (row) db.prepare(`UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(', ')}, source = ? WHERE id = ?`).run(...keys.map(k => values[k]), source, row.id);
      else {
        const identityFields = kind === 'quirk' ? ['slug'] : ['platform','model_id'];
        const extra = kind === 'quirk' ? ['created_at_ms','updated_at_ms'] : [];
        const allKeys = [...identityFields, ...keys, 'source', ...extra];
        db.prepare(`INSERT INTO ${table} (${allKeys.join(',')}) VALUES (${allKeys.map(() => '?').join(',')})`).run(...params, ...keys.map(k => values[k]), source, ...extra.map(() => Date.now()));
      }
      const id = (db.prepare(`SELECT id FROM ${table} WHERE ${condition}`).get(...params) as { id: number }).id;
      if (kind === 'quirk') {
        db.prepare('DELETE FROM quirk_targets WHERE quirk_id = ?').run(id);
        for (const t of values.targets ?? []) db.prepare('INSERT INTO quirk_targets(quirk_id, platform, model_glob) VALUES (?, ?, ?)').run(id, t.platform, t.model_glob);
        db.prepare('UPDATE quirks SET updated_at_ms = ? WHERE id = ?').run(Date.now(), id);
      }
      if (kind === 'chat') {
        db.prepare('DELETE FROM model_overrides WHERE platform = ? AND model_id = ?').run(input.platform, input.modelId);
        db.prepare('INSERT INTO fallback_config(model_db_id, priority, enabled) SELECT ?, COALESCE(MAX(priority), 0) + 1, 1 FROM fallback_config WHERE NOT EXISTS (SELECT 1 FROM fallback_config WHERE model_db_id = ?) HAVING NOT EXISTS (SELECT 1 FROM fallback_config WHERE model_db_id = ?)').run(id, id, id);
        ensureAllModelsInProfiles(db);
      }
      if (kind === 'chat' || kind === 'media') db.prepare('DELETE FROM catalog_model_tombstones WHERE kind = ? AND platform = ? AND model_id = ?').run(kind, input.platform, input.modelId);
    }
    const origin = action === 'restore' ? null : (input.origin ?? existing?.origin ?? (owner === 'user' ? 'manual' : null));
    const extensions = action === 'restore' ? {} : (input.extensions ?? existing?.extensions ?? {});
    if ((origin !== null && (typeof origin !== 'string' || origin.length > 200)) || !extensions || typeof extensions !== 'object' || Array.isArray(extensions) || JSON.stringify(extensions).length > 32000) throw new CatalogError(400, 'Invalid origin/extensions (object, max 32KB)');
    db.prepare(`INSERT INTO catalog_annotations(kind, platform, model_id, origin, extensions_json, deleted_source) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(kind, platform, model_id) DO UPDATE SET origin=excluded.origin, extensions_json=excluded.extensions_json, deleted_source=excluded.deleted_source`).run(kind, input.platform, input.modelId, origin, JSON.stringify(extensions), action === 'delete' ? owner : null);
    db.prepare('UPDATE catalog_annotations SET updated_at_ms = ? WHERE kind = ? AND platform = ? AND model_id = ?').run(Date.now(), kind, input.platform, input.modelId);
    audit(action, { kind, platform: input.platform, modelId: input.modelId, source });
    return { skipped: false, record: action === 'delete' ? null : readCatalog(input) };
  })();
}
export function checkCatalogUpdates() {
  return syncCatalog(true, 'catalog-page');
}
