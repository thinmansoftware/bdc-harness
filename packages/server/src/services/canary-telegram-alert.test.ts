import { describe, expect, mock, test } from 'bun:test';
import { renderCanaryAlert, sendCanaryTelegramAlert } from './canary-telegram-alert';

describe('canary telegram alert', () => {
  test('renders probe red and warn prefixes', () => {
    expect(
      renderCanaryAlert({
        level: 'red',
        workflowName: 'lane',
        errorClass: 'structural_model_not_supported',
        errorBodyExcerpt: 'unsupported',
      })
    ).toContain('[CANARY PROBE RED]');
    expect(
      renderCanaryAlert({
        level: 'warn',
        workflowName: 'lane',
        errorClass: 'unknown_400',
        errorBodyExcerpt: 'bad request',
      })
    ).toContain('[CANARY PROBE WARN]');
  });

  test('does not send without token or chat id', async () => {
    const fetcher = mock(fetch);
    const oldToken = process.env.TELEGRAM_BOT_TOKEN;
    const oldChat = process.env.CANARY_TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.CANARY_TELEGRAM_CHAT_ID;
    try {
      await expect(
        sendCanaryTelegramAlert({
          level: 'red',
          workflowName: 'lane',
          errorClass: 'structural_model_not_supported',
          errorBodyExcerpt: 'unsupported',
          fetcher,
        })
      ).resolves.toBe(false);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      if (oldToken) process.env.TELEGRAM_BOT_TOKEN = oldToken;
      if (oldChat) process.env.CANARY_TELEGRAM_CHAT_ID = oldChat;
    }
  });
});
