import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export const packageInfo: { name: string; version: string } = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
