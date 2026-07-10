import { readFile } from 'fs/promises';
import { join } from 'path';
import {
  type Baseline,
  authorizedWebhookSchema,
  baselineSchema,
  containerInventoryEntrySchema,
  expectedOpenPortSchema,
  legitimateAnonGrantSchema,
} from './types';

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function loadBaseline(root: string): Promise<Baseline> {
  const expectedOpenPorts = expectedOpenPortSchema
    .array()
    .parse(await readJson(join(root, 'expected-open-ports.json')));
  const legitimateAnonGrants = legitimateAnonGrantSchema
    .array()
    .parse(await readJson(join(root, 'legitimate-anon-grants.json')));
  const authorizedWebhooks = authorizedWebhookSchema
    .array()
    .parse(await readJson(join(root, 'authorized-webhooks.json')));
  const containerInventory = containerInventoryEntrySchema
    .array()
    .parse(await readJson(join(root, 'container-inventory.json')));

  return baselineSchema.parse({
    schemaVersion: 1,
    expectedOpenPorts,
    legitimateAnonGrants,
    authorizedWebhooks,
    containerInventory,
  });
}
