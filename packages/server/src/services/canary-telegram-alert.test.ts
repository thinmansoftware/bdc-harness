import { expect, mock, test } from 'bun:test';
import {
  renderCanaryProbeRed,
  renderCanaryProbeWarn,
  renderLayer2Red,
  sendCanaryTelegramAlert,
} from './canary-telegram-alert';

test('renders canary alert message prefixes', () => {
  expect(
    renderCanaryProbeRed({
      workflowName: 'lane',
      providerId: 'codex',
      modelId: 'qwen',
      errorClass: 'structural_model_not_supported',
    })
  ).toContain('[CANARY PROBE RED]');
  expect(
    renderCanaryProbeWarn({
      workflowName: 'lane',
      providerId: 'codex',
      modelId: 'qwen',
      errorClass: 'unknown_400',
    })
  ).toContain('[CANARY PROBE WARN]');
  expect(renderLayer2Red({ lane: 'lane', reason: 'fixture failed' })).toContain('[L2 RED]');
});

test('fails loud without a Telegram token', async () => {
  const original = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  try {
    await expect(sendCanaryTelegramAlert('x')).rejects.toThrow('TELEGRAM_BOT_TOKEN_required');
  } finally {
    if (original === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = original;
  }
});

test('uses injectable sender', async () => {
  const sender = mock(async () => {});
  await sendCanaryTelegramAlert('x', { token: 'token', sender });
  expect(sender).toHaveBeenCalledWith({ token: 'token', chatId: '8631463074', text: 'x' });
});
