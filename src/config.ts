import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { parse } from 'dotenv';

/** Verified against the product HTTP route and production deployment workflow. */
export const DEFAULT_MCP_URL = 'https://steercards.com/api/mcp';

export interface Config {
  url: string;
  agentKey: string;
  cwd: string;
  envFile: string;
  keySource: 'environment' | 'env-file';
}

export interface ConfigOptions {
  cwd?: string;
  envFile?: string;
  url?: string;
  /** Supply an isolated environment for embedding or tests. Never mutated. */
  env?: NodeJS.ProcessEnv;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function validateMcpUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ConfigError('STEERCARDS_MCP_URL must be an absolute HTTP(S) URL.'); }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError('STEERCARDS_MCP_URL must not contain credentials, a query, or a fragment.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ConfigError('STEERCARDS_MCP_URL requires HTTPS, except for localhost.');
  }
  return url.href;
}

/** Read one selected file only; do not traverse parents or hydrate process.env. */
export async function loadConfig(options: ConfigOptions = {}): Promise<Config> {
  const cwd = resolve(options.cwd ?? process.cwd());
  try {
    if (!(await stat(cwd)).isDirectory()) throw new Error();
  } catch { throw new ConfigError('The selected working directory does not exist or is not a directory.'); }
  const envFile = options.envFile && isAbsolute(options.envFile)
    ? options.envFile : resolve(cwd, options.envFile ?? '.env');
  let file: Record<string, string> = {};
  try { file = parse(await readFile(envFile)); }
  catch (error) {
    if (options.envFile !== undefined || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ConfigError('Unable to read the selected environment file.');
    }
  }
  const env = options.env ?? process.env;
  const fromEnvironment = env.STEERCARDS_AGENT_KEY !== undefined;
  const agentKey = fromEnvironment ? env.STEERCARDS_AGENT_KEY : file.STEERCARDS_AGENT_KEY;
  if (!agentKey || /\s/.test(agentKey)) {
    throw new ConfigError('Set STEERCARDS_AGENT_KEY to a nonempty Agent Key without whitespace.');
  }
  const url = validateMcpUrl(options.url ?? env.STEERCARDS_MCP_URL ?? file.STEERCARDS_MCP_URL ?? DEFAULT_MCP_URL);
  return { url, agentKey, cwd, envFile, keySource: fromEnvironment ? 'environment' : 'env-file' };
}
