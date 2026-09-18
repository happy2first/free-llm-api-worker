import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb, setSetting } from '../../db/index.js';
import { up as repair } from '../../db/migrations/20260918_000001_siliconflow_identity_catalog_repair.js';

describe('SiliconFlow identity/catalog repair migration', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('keeps Global and China separate, removes stale managed CN config, and seeds only verified free CN capabilities', () => {
    const db = getDb();
    setSetting('managed_provider_registry_v1', JSON.stringify([
      { platform: 'siliconflow-cn', name: 'Old dynamic CN', protocol: 'openai-compatible', baseUrl: 'https://api.siliconflow.cn/v1', source: 'ai', updatedAt: 1 },
      { platform: 'managed-other', name: 'Other', protocol: 'openai-compatible', baseUrl: 'https://example.com/v1', source: 'ai', updatedAt: 1 },
    ]));

    db.prepare(`
      INSERT OR REPLACE INTO media_models(platform, model_id, display_name, modality, priority, enabled, quota_label, source)
      VALUES ('siliconflow-cn', 'FunAudioLLM/CosyVoice2-0.5B', 'CosyVoice2', 'audio', 1, 1, 'Free', 'ai')
    `).run();

    repair(db);

    const registry = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'managed_provider_registry_v1'").get() as { value: string }).value);
    expect(registry.map((r: any) => r.platform)).toEqual(['managed-other']);

    const chat = db.prepare("SELECT model_id, source, enabled FROM models WHERE platform = 'siliconflow-cn' ORDER BY model_id").all() as any[];
    expect(chat.map(r => r.model_id)).toEqual(expect.arrayContaining([
      'Qwen/Qwen3.5-4B',
      'tencent/Hunyuan-MT-7B',
      'XingChenAGI/Xing4.0-29B',
      'PaddlePaddle/PaddleOCR-VL-1.5',
    ]));
    expect(chat.every(r => r.source === 'ai' && r.enabled === 1)).toBe(true);

    const fallbackCount = db.prepare(`
      SELECT COUNT(*) AS n
      FROM fallback_config f
      JOIN models m ON m.id = f.model_db_id
      WHERE m.platform = 'siliconflow-cn'
        AND m.model_id IN ('Qwen/Qwen3.5-4B','tencent/Hunyuan-MT-7B','XingChenAGI/Xing4.0-29B','PaddlePaddle/PaddleOCR-VL-1.5')
    `).get() as { n: number };
    expect(fallbackCount.n).toBe(4);

    const embeddings = db.prepare("SELECT model_id, source FROM embedding_models WHERE platform = 'siliconflow-cn' ORDER BY model_id").all() as any[];
    expect(embeddings.map(r => r.model_id)).toEqual([
      'BAAI/bge-large-en-v1.5',
      'BAAI/bge-large-zh-v1.5',
      'BAAI/bge-m3',
    ]);
    expect(embeddings.every(r => r.source === 'ai')).toBe(true);

    const image = db.prepare("SELECT model_id, modality, source FROM media_models WHERE platform = 'siliconflow-cn' AND model_id = 'Kwai-Kolors/Kolors'").get() as any;
    expect(image).toMatchObject({ model_id: 'Kwai-Kolors/Kolors', modality: 'image', source: 'ai' });

    expect(db.prepare("SELECT 1 FROM media_models WHERE platform = 'siliconflow-cn' AND model_id = 'FunAudioLLM/CosyVoice2-0.5B' AND source = 'ai'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM media_models WHERE platform = 'siliconflow-cn' AND modality = 'audio' AND source = 'ai'").get()).toBeUndefined();

    const qwenAnnotation = db.prepare("SELECT extensions_json FROM catalog_annotations WHERE kind = 'chat' AND platform = 'siliconflow-cn' AND model_id = 'Qwen/Qwen3.5-4B'").get() as { extensions_json: string };
    const ext = JSON.parse(qwenAnnotation.extensions_json);
    expect(ext.requiresKyc).toBe(true);
    expect(ext.requiresCreditCard).toBe(false);
    expect(ext.evidenceLinks.some((u: string) => u.includes('siliconflow.cn'))).toBe(true);
  });

  it('does not overwrite user-owned rows', () => {
    const db = getDb();
    db.prepare("UPDATE models SET display_name = 'My Qwen', source = 'user' WHERE platform = 'siliconflow-cn' AND model_id = 'Qwen/Qwen3.5-4B'").run();
    db.prepare(`
      INSERT OR REPLACE INTO media_models(platform, model_id, display_name, modality, priority, enabled, quota_label, source)
      VALUES ('siliconflow-cn', 'FunAudioLLM/CosyVoice2-0.5B', 'My paid TTS', 'audio', 1, 1, 'User configured', 'user')
    `).run();

    repair(db);

    expect(db.prepare("SELECT display_name, source FROM models WHERE platform = 'siliconflow-cn' AND model_id = 'Qwen/Qwen3.5-4B'").get()).toMatchObject({ display_name: 'My Qwen', source: 'user' });
    expect(db.prepare("SELECT display_name, source FROM media_models WHERE platform = 'siliconflow-cn' AND model_id = 'FunAudioLLM/CosyVoice2-0.5B'").get()).toMatchObject({ display_name: 'My paid TTS', source: 'user' });
  });
});
