import { z } from 'zod';

export const SEVERITIES = ['CLEAN', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const MODULE_IDS = [
  'port-exposure',
  'secret-scan',
  'webhook-probe',
  'rls-anon-sweep',
  'world-readable',
  'legacy-twelve',
] as const;

export const severitySchema = z.enum(SEVERITIES);
export const moduleIdSchema = z.enum(MODULE_IDS);

export type Severity = z.infer<typeof severitySchema>;
export type ModuleId = z.infer<typeof moduleIdSchema>;

export const findingSchema = z
  .object({
    module: moduleIdSchema,
    severity: severitySchema,
    target: z.string().trim().min(1),
    evidence: z.record(z.string(), z.unknown()).default({}),
    reason_code: z.string().regex(/^[a-z0-9_:-]+$/),
  })
  .strict()
  .superRefine((finding, context) => {
    const serialized = JSON.stringify(finding);
    if (FORBIDDEN_ACTION_PATTERN.test(serialized)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'phase1_finding_contains_action_string',
      });
    }
  });

export type Finding = z.infer<typeof findingSchema>;

export const expectedOpenPortSchema = z
  .object({
    port: z.number().int().positive().max(65535),
    protocol: z.enum(['tcp', 'udp']).default('tcp'),
    addressFamily: z.enum(['v4', 'v6', 'any']).default('any'),
    allowedSources: z.array(z.string().trim().min(1)).default([]),
    reason: z.string().trim().min(1),
  })
  .strict();

export const legitimateAnonGrantSchema = z
  .object({
    instance: z.enum(['prod', 'staging']),
    schema: z.string().trim().min(1),
    table: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  })
  .strict();

export const authorizedWebhookSchema = z
  .object({
    path: z.string().trim().min(1),
    methods: z.array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])).min(1),
    reason: z.string().trim().min(1),
  })
  .strict();

export const containerInventoryEntrySchema = z
  .object({
    name: z.string().trim().min(1),
    required: z.boolean().default(true),
    secretFilePaths: z.array(z.string().trim().min(1)).default([]),
    checks: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();

export const baselineSchema = z
  .object({
    schemaVersion: z.literal(1),
    expectedOpenPorts: z.array(expectedOpenPortSchema),
    legitimateAnonGrants: z.array(legitimateAnonGrantSchema),
    authorizedWebhooks: z.array(authorizedWebhookSchema),
    containerInventory: z.array(containerInventoryEntrySchema),
  })
  .strict();

export type ExpectedOpenPort = z.infer<typeof expectedOpenPortSchema>;
export type LegitimateAnonGrant = z.infer<typeof legitimateAnonGrantSchema>;
export type AuthorizedWebhook = z.infer<typeof authorizedWebhookSchema>;
export type ContainerInventoryEntry = z.infer<typeof containerInventoryEntrySchema>;
export type Baseline = z.infer<typeof baselineSchema>;

export const scanReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().trim().min(1),
    generatedAt: z.string().trim().min(1),
    verdict: severitySchema,
    findings: z.array(findingSchema),
    reasonCodes: z.array(z.string().trim().min(1)),
  })
  .strict()
  .superRefine((report, context) => {
    if (FORBIDDEN_ACTION_PATTERN.test(JSON.stringify(report))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'phase1_report_contains_action_string',
      });
    }
  });

export type ScanReport = z.infer<typeof scanReportSchema>;

const forbiddenActionFragments = [
  ['iptables -', 'A .*AC', 'CEPT'],
  ['ufw ', 'allow'],
  ['GR', 'ANT '],
  ['chmod 7', '7'],
  ['ip6', 'tables'],
  ['net', 'filter'],
  ['de', 'activate'],
  ['kill ', '-9'],
  ['fail2ban-client ', 'set'],
] as const;

export const FORBIDDEN_ACTION_PATTERN = new RegExp(
  forbiddenActionFragments.map(parts => parts.join('')).join('|'),
  'i'
);

export const severityRank: Record<Severity, number> = {
  CLEAN: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

export function maxSeverity(values: readonly Severity[]): Severity {
  return values.reduce<Severity>(
    (current, next) => (severityRank[next] > severityRank[current] ? next : current),
    'CLEAN'
  );
}
