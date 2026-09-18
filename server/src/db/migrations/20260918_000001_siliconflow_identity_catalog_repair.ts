import type { Db } from '../types.js';

const PLATFORM = 'siliconflow-cn';
const NOW = Date.UTC(2026, 8, 18, 0, 0, 0);
const ORIGIN = 'siliconflow-cn-official-pricing-2026-09-18';
const PRICING = 'https://siliconflow.cn/pricing';
const QWEN_NEWS = 'https://www.siliconflow.cn/news/yg6n19y2g6frnp4koxu8ye48';
const RATE_LIMITS = 'https://api-docs.siliconflow.cn/docs/userguide/faqs/rate-limit-and-upgradation';
const EMBEDDINGS_DOC = 'https://api-docs.siliconflow.cn/docs/api/embeddings-post';

function annotation(db: Db, kind: string, modelId: string, freeQuota: string, evidenceLinks: string[], notes: string) {
  const extensions = {
    credentialRequirement: 'SiliconFlow China API key; free models require real-name verification',
    freeQuota,
    requiresCreditCard: false,
    requiresPhone: null,
    requiresKyc: true,
    signupUrl: 'https://cloud.siliconflow.cn/account/ak',
    regions: ['CN'],
    notes,
    evidenceLinks,
  };
  db.prepare(`
    INSERT INTO catalog_annotations(kind, platform, model_id, origin, extensions_json, deleted_source, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(kind, platform, model_id) DO UPDATE SET
      origin = excluded.origin,
      extensions_json = excluded.extensions_json,
      deleted_source = NULL,
      updated_at_ms = excluded.updated_at_ms
  `).run(kind, PLATFORM, modelId, ORIGIN, JSON.stringify(extensions), NOW);
}

function upsertChat(
  db: Db,
  row: { modelId: string; displayName: string; size: string; vision?: boolean; evidence: string[]; freeQuota: string; notes: string },
) {
  const existing = db.prepare("SELECT id, source FROM models WHERE platform = ? AND model_id = ? AND endpoint_scope = ''").get(PLATFORM, row.modelId) as { id: number; source: string } | undefined;
  if (existing?.source === 'user') return;

  db.prepare(`
    INSERT INTO models
      (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
       rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
       context_window, enabled, supports_vision, source, endpoint_scope)
    VALUES (?, ?, ?, 999, 999, ?, NULL, NULL, NULL, NULL, '', NULL, 1, ?, 'ai', '')
    ON CONFLICT(platform, model_id, endpoint_scope) DO UPDATE SET
      display_name = excluded.display_name,
      size_label = excluded.size_label,
      enabled = 1,
      supports_vision = excluded.supports_vision,
      source = CASE WHEN models.source = 'user' THEN models.source ELSE 'ai' END
  `).run(PLATFORM, row.modelId, row.displayName, row.size, row.vision ? 1 : 0);

  const model = db.prepare("SELECT id FROM models WHERE platform = ? AND model_id = ? AND endpoint_scope = ''").get(PLATFORM, row.modelId) as { id: number };
  const hasFallback = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(model.id);
  if (!hasFallback) {
    const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS p FROM fallback_config').get() as { p: number };
    db.prepare('INSERT INTO fallback_config(model_db_id, priority, enabled) VALUES (?, ?, 1)').run(model.id, max.p + 1);
  }
  const profiles = db.prepare('SELECT id FROM profiles WHERE auto_include_new_models = 1 ORDER BY id').all() as { id: number }[];
  for (const profile of profiles) {
    const present = db.prepare('SELECT 1 FROM profile_models WHERE profile_id = ? AND model_db_id = ?').get(profile.id, model.id);
    if (present) continue;
    const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS p FROM profile_models WHERE profile_id = ?').get(profile.id) as { p: number };
    db.prepare('INSERT INTO profile_models(profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)').run(profile.id, model.id, max.p + 1);
  }
  annotation(db, 'chat', row.modelId, row.freeQuota, row.evidence, row.notes);
}

function upsertEmbedding(
  db: Db,
  row: { modelId: string; displayName: string; family: string; dimensions: number; maxInput: number; evidence: string[] },
) {
  const existing = db.prepare('SELECT source FROM embedding_models WHERE platform = ? AND model_id = ?').get(PLATFORM, row.modelId) as { source: string } | undefined;
  if (existing?.source === 'user') return;
  db.prepare(`
    INSERT INTO embedding_models
      (family, platform, model_id, display_name, dimensions, max_input_tokens, priority, enabled, quota_label, source)
    VALUES (?, ?, ?, ?, ?, ?, 1, 1, 'Free · fixed model rate limits', 'ai')
    ON CONFLICT(platform, model_id) DO UPDATE SET
      family = excluded.family,
      display_name = excluded.display_name,
      dimensions = excluded.dimensions,
      max_input_tokens = excluded.max_input_tokens,
      enabled = 1,
      quota_label = excluded.quota_label,
      source = CASE WHEN embedding_models.source = 'user' THEN embedding_models.source ELSE 'ai' END
  `).run(row.family, PLATFORM, row.modelId, row.displayName, row.dimensions, row.maxInput);
  annotation(
    db, 'embedding', row.modelId,
    'Free (¥0); fixed free-model rate limits, model/account scoped',
    row.evidence,
    'China site only. Pricing currently marks the non-Pro embedding model free; Pro variants are paid.',
  );
}

function upsertImage(db: Db) {
  const modelId = 'Kwai-Kolors/Kolors';
  const existing = db.prepare('SELECT source FROM media_models WHERE platform = ? AND model_id = ?').get(PLATFORM, modelId) as { source: string } | undefined;
  if (existing?.source !== 'user') {
    db.prepare(`
      INSERT INTO media_models(platform, model_id, display_name, modality, priority, enabled, quota_label, source)
      VALUES (?, ?, 'Kolors', 'image', 1, 1, 'Free', 'ai')
      ON CONFLICT(platform, model_id) DO UPDATE SET
        display_name = excluded.display_name,
        modality = 'image',
        enabled = 1,
        quota_label = 'Free',
        source = CASE WHEN media_models.source = 'user' THEN media_models.source ELSE 'ai' END
    `).run(PLATFORM, modelId);
  }
  annotation(
    db, 'media', modelId,
    'Free (¥0 per image on current SiliconFlow China pricing page)',
    [PRICING, RATE_LIMITS],
    'China site only. This is the current free image-generation row; paid image models are intentionally excluded.',
  );
}

function removeStaleManagedDefinition(db: Db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'managed_provider_registry_v1'").get() as { value: string } | undefined;
  if (!row) return;
  try {
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return;
    const stale = parsed.filter((item: any) => item?.platform === PLATFORM);
    if (stale.length > 0) {
      db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('siliconflow_cn_managed_provider_backup_20260918', ?)").run(JSON.stringify(stale));
      db.prepare("UPDATE settings SET value = ? WHERE key = 'managed_provider_registry_v1'").run(JSON.stringify(parsed.filter((item: any) => item?.platform !== PLATFORM)));
    }
  } catch {
    // Leave malformed registry untouched; startup validation should surface it.
  }
}

function removeKnownPaidTtsMistakes(db: Db, platform: string) {
  for (const modelId of ['FunAudioLLM/CosyVoice2-0.5B', 'fnlp/MOSS-TTSD-v0.5']) {
    const row = db.prepare("SELECT source FROM media_models WHERE platform = ? AND model_id = ? AND modality = 'audio'").get(platform, modelId) as { source: string } | undefined;
    if (!row || row.source === 'user') continue;
    db.prepare("DELETE FROM media_models WHERE platform = ? AND model_id = ? AND modality = 'audio'").run(platform, modelId);
    db.prepare("DELETE FROM catalog_annotations WHERE kind = 'media' AND platform = ? AND model_id = ?").run(platform, modelId);
  }
}

export function up(db: Db): void {
  removeStaleManagedDefinition(db);

  // Global and China are distinct. Remove only non-user rows whose old metadata
  // incorrectly claimed these TTS models were free.
  removeKnownPaidTtsMistakes(db, 'siliconflow');
  removeKnownPaidTtsMistakes(db, PLATFORM);

  const commonRateNote = 'Free model. SiliconFlow documents fixed per-model, account-level limits for free models; current numeric limits are shown in the model marketplace.';
  upsertChat(db, {
    modelId: 'Qwen/Qwen3.5-4B',
    displayName: 'Qwen3.5-4B',
    size: 'Small',
    vision: true,
    freeQuota: commonRateNote,
    evidence: [QWEN_NEWS, RATE_LIMITS],
    notes: 'SiliconFlow China explicitly announced the 4B model as free. China and Global account/key namespaces are independent.',
  });
  upsertChat(db, {
    modelId: 'tencent/Hunyuan-MT-7B',
    displayName: 'Hunyuan-MT-7B',
    size: 'Small',
    freeQuota: commonRateNote,
    evidence: [PRICING, RATE_LIMITS],
    notes: 'Current China pricing page marks both input and output free.',
  });
  upsertChat(db, {
    modelId: 'XingChenAGI/Xing4.0-29B',
    displayName: 'Xing4.0-29B',
    size: 'Medium',
    freeQuota: commonRateNote,
    evidence: [PRICING, RATE_LIMITS],
    notes: 'Current China pricing page marks both input and output free.',
  });
  upsertChat(db, {
    modelId: 'PaddlePaddle/PaddleOCR-VL-1.5',
    displayName: 'PaddleOCR-VL-1.5',
    size: 'Small',
    vision: true,
    freeQuota: commonRateNote,
    evidence: [PRICING, RATE_LIMITS],
    notes: 'Current China pricing page classifies this as a free chat/multimodal model.',
  });

  upsertEmbedding(db, { modelId: 'BAAI/bge-m3', displayName: 'BGE-M3', family: 'bge-m3', dimensions: 1024, maxInput: 8192, evidence: [PRICING, EMBEDDINGS_DOC, RATE_LIMITS] });
  upsertEmbedding(db, { modelId: 'BAAI/bge-large-zh-v1.5', displayName: 'BGE Large ZH v1.5', family: 'bge-large-zh-v1.5', dimensions: 1024, maxInput: 512, evidence: [PRICING, EMBEDDINGS_DOC, RATE_LIMITS] });
  upsertEmbedding(db, { modelId: 'BAAI/bge-large-en-v1.5', displayName: 'BGE Large EN v1.5', family: 'bge-large-en-v1.5', dimensions: 1024, maxInput: 512, evidence: [PRICING, EMBEDDINGS_DOC, RATE_LIMITS] });

  upsertImage(db);

  db.prepare(`
    INSERT INTO catalog_history(at_ms, action, detail_json)
    VALUES (?, 'siliconflow_identity_catalog_repair', ?)
  `).run(NOW, JSON.stringify({
    platform: PLATFORM,
    globalPlatform: 'siliconflow',
    seeded: {
      chat: ['Qwen/Qwen3.5-4B', 'tencent/Hunyuan-MT-7B', 'XingChenAGI/Xing4.0-29B', 'PaddlePaddle/PaddleOCR-VL-1.5'],
      embedding: ['BAAI/bge-m3', 'BAAI/bge-large-zh-v1.5', 'BAAI/bge-large-en-v1.5'],
      image: ['Kwai-Kolors/Kolors'],
      tts: [],
    },
    note: 'No free TTS seeded: current China pricing lists CosyVoice2 and MOSS-TTSD as paid.',
  }));
}

export function down(db: Db): void {
  const chat = ['Qwen/Qwen3.5-4B', 'tencent/Hunyuan-MT-7B', 'XingChenAGI/Xing4.0-29B', 'PaddlePaddle/PaddleOCR-VL-1.5'];
  for (const modelId of chat) {
    const row = db.prepare("SELECT id, source FROM models WHERE platform = ? AND model_id = ? AND endpoint_scope = ''").get(PLATFORM, modelId) as { id: number; source: string } | undefined;
    if (row?.source !== 'ai') continue;
    db.prepare('DELETE FROM profile_models WHERE model_db_id = ?').run(row.id);
    db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(row.id);
    db.prepare('DELETE FROM models WHERE id = ?').run(row.id);
    db.prepare("DELETE FROM catalog_annotations WHERE kind = 'chat' AND platform = ? AND model_id = ?").run(PLATFORM, modelId);
  }
  for (const modelId of ['BAAI/bge-m3', 'BAAI/bge-large-zh-v1.5', 'BAAI/bge-large-en-v1.5']) {
    db.prepare("DELETE FROM embedding_models WHERE platform = ? AND model_id = ? AND source = 'ai'").run(PLATFORM, modelId);
    db.prepare("DELETE FROM catalog_annotations WHERE kind = 'embedding' AND platform = ? AND model_id = ?").run(PLATFORM, modelId);
  }
  db.prepare("DELETE FROM media_models WHERE platform = ? AND model_id = 'Kwai-Kolors/Kolors' AND source = 'ai'").run(PLATFORM);
  db.prepare("DELETE FROM catalog_annotations WHERE kind = 'media' AND platform = ? AND model_id = 'Kwai-Kolors/Kolors'").run(PLATFORM);

  const backup = db.prepare("SELECT value FROM settings WHERE key = 'siliconflow_cn_managed_provider_backup_20260918'").get() as { value: string } | undefined;
  if (backup) {
    try {
      const stale = JSON.parse(backup.value);
      const currentRow = db.prepare("SELECT value FROM settings WHERE key = 'managed_provider_registry_v1'").get() as { value: string } | undefined;
      const current = currentRow ? JSON.parse(currentRow.value) : [];
      if (Array.isArray(stale) && Array.isArray(current)) {
        db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('managed_provider_registry_v1', ?)").run(JSON.stringify([...current.filter((item: any) => item?.platform !== PLATFORM), ...stale]));
      }
    } catch {}
    db.prepare("DELETE FROM settings WHERE key = 'siliconflow_cn_managed_provider_backup_20260918'").run();
  }
}
