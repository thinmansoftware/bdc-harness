import { describe, expect, it } from 'bun:test';
import { DEFAULT_CONFIG_PATH, loadConfig } from '../config.js';

const RETIRED_GLM_MODEL = /glm-5\.2|z-ai\/glm/i;
const APPROVED_SYSTEMS_MODEL = 'deepseek/deepseek-chat-v3.1';

describe('fusion shipped config', () => {
  it('does not route any role to retired GLM models', () => {
    const config = loadConfig(DEFAULT_CONFIG_PATH);
    const modelIds = [
      ...config.reviewers.map(reviewer => reviewer.modelId),
      config.synthesizer.modelId,
    ];

    for (const modelId of modelIds) {
      expect(modelId).not.toMatch(RETIRED_GLM_MODEL);
    }
  });

  it('uses DeepSeek for the systems reviewer', () => {
    const config = loadConfig(DEFAULT_CONFIG_PATH);
    const systemsReviewer = config.reviewers.find(reviewer => reviewer.id === 'systems');

    expect(systemsReviewer).toBeDefined();
    expect(systemsReviewer?.modelId).toBe(APPROVED_SYSTEMS_MODEL);
  });
});
