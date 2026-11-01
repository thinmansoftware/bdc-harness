const FOLLOW_UP_ISSUE = /^thinmansoftware\/bdc-(harness|xo)#[0-9]+$/;

export function skipOnWindows(input: { reason: string; followUp: string }): boolean {
  if (input.reason.length < 20) {
    throw new Error('skipOnWindows reason must be at least 20 characters');
  }
  if (!FOLLOW_UP_ISSUE.test(input.followUp)) {
    throw new Error(
      'skipOnWindows followUp must match thinmansoftware/bdc-harness#<n> or thinmansoftware/bdc-xo#<n>'
    );
  }
  return process.platform === 'win32';
}
