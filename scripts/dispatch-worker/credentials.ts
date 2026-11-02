import { readFile } from 'fs/promises';

export async function resolveOperatorToken(data: {
  envName: string;
  tokenFile?: string;
  env?: Record<string, string | undefined>;
}): Promise<string> {
  const env = data.env ?? process.env;
  const fromEnv = env[data.envName]?.trim();
  if (fromEnv) return fromEnv;
  if (data.tokenFile) {
    try {
      const fromFile = (await readFile(data.tokenFile, 'utf8')).trim();
      if (fromFile) return fromFile;
    } catch {
      // Fall through to the stable error below without exposing the path or value.
    }
  }
  throw new Error('operator_token_unavailable');
}
