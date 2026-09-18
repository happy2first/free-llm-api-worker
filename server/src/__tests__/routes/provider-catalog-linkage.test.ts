import { beforeEach, describe, expect, it } from 'vitest';
import { initDb } from '../../db/index.js';
import { mutateCatalog } from '../../services/catalog-management.js';
import { callProviderTool, providerTools } from '../../routes/provider-mcp.js';

describe('MCP Provider↔Catalog linkage contract', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('advertises an explicit association audit tool and provider_register maintenance contract', () => {
    const names = providerTools.map(t => t.name);
    expect(names).toContain('provider_catalog_status');
    const register = providerTools.find(t => t.name === 'provider_register')!;
    expect(register.description).toContain('does NOT create Catalog models');
    expect(register.description).toContain('provider_catalog_status');
    expect(register.description).toContain('Never stop after provider_register');
  });

  it('reports Catalog association counts for a registered provider', async () => {
    mutateCatalog('create', {
      kind: 'chat',
      platform: 'groq',
      modelId: 'linkage-test-model',
      values: { display_name: 'Linkage test model' },
    }, 'ai');

    const result = await callProviderTool('provider_catalog_status', { platform: 'groq' }) as any;
    expect(result.platform).toBe('groq');
    expect(result.provider).toBeTruthy();
    expect(result.catalog.byKind.chat).toBeGreaterThanOrEqual(1);
    expect(result.warnings).not.toContain('catalog_platform_not_registered');
  });

  it('rejects Catalog creation for an unregistered provider instead of creating an orphan', () => {
    expect(() => mutateCatalog('create', {
      kind: 'chat',
      platform: 'orphan-provider',
      modelId: 'orphan-model',
      values: { display_name: 'Orphan model' },
    }, 'ai')).toThrow(/Register the provider first/);
  });

  it('rejects media Catalog rows when the provider transport has no media adapter', () => {
    expect(() => mutateCatalog('create', {
      kind: 'media',
      platform: 'groq',
      modelId: 'fake-image-model',
      values: { display_name: 'Fake image', modality: 'image' },
    }, 'ai')).toThrow(/no runtime adapter/);
  });
});
