'use client';

import type { CortexConfig } from './types';

interface LLMProviderSectionProps {
  config: CortexConfig | null;
  saving: boolean;
  apiKeyInput: string;
  onApiKeyInputChange: (next: string) => void;
  showApiKey: boolean;
  onToggleShowApiKey: () => void;
  onSaveConfig: (updates: Partial<CortexConfig>) => void;
}

export function LLMProviderSection({
  config,
  saving,
  apiKeyInput,
  onApiKeyInputChange,
  showApiKey,
  onToggleShowApiKey,
  onSaveConfig,
}: LLMProviderSectionProps) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', marginBottom: 4 }}>
        LLM Provider
      </div>
      <p style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)', margin: '0 0 16px', lineHeight: '1.4' }}>
        Cortex uses an LLM for fact extraction, enrichment, and classification. Configure your provider and API key.
      </p>

      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--t-text, #0f172a)', marginBottom: 6 }}>
          Provider
        </label>
        <select
          value={config?.llmProvider || ''}
          onChange={(e) => onSaveConfig({ llmProvider: e.target.value })}
          disabled={saving}
          style={{
            width: '100%',
            paddingTop: 10,
            paddingBottom: 10,
            paddingLeft: 12,
            paddingRight: 12,
            borderRadius: 10,
            border: '1px solid var(--t-border, #e2e8f0)',
            background: 'var(--t-bg, white)',
            color: 'var(--t-text, #0f172a)',
            fontSize: 13,
            outline: 'none',
          }}
        >
          <option value="">— Select provider —</option>
          <option value="openrouter">OpenRouter (recommended — access all models)</option>
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
          <option value="google">Google AI</option>
          <option value="ollama">Ollama (local, no key needed)</option>
        </select>
      </div>

      {config?.llmProvider && config.llmProvider !== 'ollama' && (
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--t-text, #0f172a)', marginBottom: 6 }}>
            API Key
            {config.llmApiKeySet && (
              <span style={{
                marginLeft: 8,
                fontSize: 10,
                paddingTop: 2,
                paddingBottom: 2,
                paddingLeft: 6,
                paddingRight: 6,
                borderRadius: 4,
                background: 'rgba(52,211,153,0.1)',
                color: '#10b981',
              }}>
                ✓ Configured
              </span>
            )}
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type={showApiKey ? 'text' : 'password'}
              value={apiKeyInput || (showApiKey ? '' : config.llmApiKey)}
              onChange={(e) => onApiKeyInputChange(e.target.value)}
              placeholder={config.llmApiKeySet ? 'Enter new key to replace' : `Enter ${config.llmProvider} API key`}
              style={{
                flex: 1,
                paddingTop: 10,
                paddingBottom: 10,
                paddingLeft: 12,
                paddingRight: 12,
                borderRadius: 10,
                border: '1px solid var(--t-border, #e2e8f0)',
                background: 'var(--t-bg, white)',
                color: 'var(--t-text, #0f172a)',
                fontSize: 13,
                fontFamily: 'ui-monospace, monospace',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
            <button
              type="button"
              onClick={onToggleShowApiKey}
              style={{
                paddingTop: 8,
                paddingBottom: 8,
                paddingLeft: 12,
                paddingRight: 12,
                borderRadius: 10,
                border: '1px solid var(--t-border, #e2e8f0)',
                background: 'var(--t-bg, white)',
                color: 'var(--t-text-muted, #94a3b8)',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              {showApiKey ? 'Hide' : 'Show'}
            </button>
            {apiKeyInput && (
              <button
                type="button"
                onClick={() => {
                  onSaveConfig({ llmApiKey: apiKeyInput });
                  onApiKeyInputChange('');
                }}
                disabled={saving}
                style={{
                  paddingTop: 8,
                  paddingBottom: 8,
                  paddingLeft: 16,
                  paddingRight: 16,
                  borderRadius: 10,
                  border: 'none',
                  background: '#3b82f6',
                  color: 'white',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Save
              </button>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)', marginTop: 6 }}>
            {config.llmProvider === 'openrouter' && (
              <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6', textDecoration: 'none' }}>
                Get an OpenRouter API key →
              </a>
            )}
            {config.llmProvider === 'anthropic' && (
              <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6', textDecoration: 'none' }}>
                Get an Anthropic API key →
              </a>
            )}
            {config.llmProvider === 'openai' && (
              <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6', textDecoration: 'none' }}>
                Get an OpenAI API key →
              </a>
            )}
            {config.llmProvider === 'google' && (
              <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6', textDecoration: 'none' }}>
                Get a Google AI API key →
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
