export type ToolOutcome = 'ok' | 'refused' | 'error';

export class ToolFailure extends Error {
  readonly outcome: 'refused' | 'error';
  readonly code: string;

  constructor(outcome: 'refused' | 'error', code: string) {
    super(code);
    this.name = 'ToolFailure';
    this.outcome = outcome;
    this.code = code;
  }
}

export class RegistryError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`registry_invalid:${field}`);
    this.name = 'RegistryError';
    this.field = field;
  }
}
