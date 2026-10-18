import { expect, test } from 'bun:test';
import { restrictedClientOptions } from './restricted-policy';

test('canary transport is explicit, fixed and leaves the offline default unchanged', () => {
  const original = restrictedClientOptions();
  const canary = restrictedClientOptions('teetime-connect-v1');
  expect(canary.env).toEqual({
    ...original.env,
    HTTPS_PROXY: 'http://teetime-proxy:3128',
    HTTP_PROXY: 'http://teetime-proxy:3128',
  });
  expect(canary.config).toEqual(original.config);
  expect(canary.configOverrides).toEqual(original.configOverrides);
  expect(original.env?.HTTPS_PROXY).toBeUndefined();
  expect(restrictedClientOptions()).toEqual(original);
});

test('arbitrary transport values fail closed', () => {
  expect(() => restrictedClientOptions('http://other:3128' as never)).toThrow('transport');
  expect(() => restrictedClientOptions(null as never)).toThrow('transport');
});
