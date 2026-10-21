import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolResultSchema, ListToolsResultSchema, ToolListChangedNotificationSchema,
  type CallToolResult, type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { validateMcpUrl, type Config } from './config.js';
import { packageInfo } from './package.js';

export type ToolSummary = Pick<Tool, 'name' | 'title' | 'annotations'> & { description?: string };

/** Extract only a small, machine-readable code; arbitrary error prose stays private. */
async function httpErrorCode(response: Response, agentKey: string): Promise<string | undefined> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json') || !response.body) {
    await response.body?.cancel();
    return undefined;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 16 * 1024) return undefined;
      chunks.push(value);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: { code?: unknown } };
    const code = parsed?.error?.code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(code)
      && !code.includes(agentKey) && !agentKey.includes(code)) return code;
  } catch { /* A malformed or interrupted diagnostic body is not itself an error. */ }
  finally { await reader.cancel().catch(() => {}); }
  return undefined;
}

/** One authenticated upstream client. Calls are never automatically retried. */
export class Runtime {
  private readonly config: Config;
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private connecting?: Promise<Client>;
  private catalog?: Tool[];
  private listing?: Promise<Tool[]>;
  private closed = false;

  constructor(config: Config, private readonly options: { signal?: AbortSignal } = {}) {
    this.config = { ...config, url: validateMcpUrl(config.url) };
    if (!config.agentKey || /\s/.test(config.agentKey)) throw new Error('STEERCARDS_AGENT_KEY is invalid.');
  }

  /** Redact credentials if a transport or upstream RPC error echoes them. */
  private safeError(error: unknown): Error {
    const message = error instanceof Error ? error.message : 'Steercards MCP request failed.';
    return new Error(message.split(this.config.agentKey).join('[redacted]'));
  }

  private async connection(): Promise<Client> {
    if (this.closed) throw new Error('Steercards runtime is closed.');
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = new Client({ name: packageInfo.name, version: packageInfo.version });
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { this.catalog = undefined; });
        const endpoint = this.config.url;
        const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
          requestInit: { headers: { Authorization: `Bearer ${this.config.agentKey}` }, redirect: 'error' },
          reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
          fetch: async (input, init) => {
            // Every request stays on the explicitly selected endpoint. Even same-origin
            // redirects are refused so bearer credentials cannot move to another route.
            const target = input instanceof Request ? input.url : input.toString();
            if (target !== endpoint) throw new Error('Refused a request outside the configured MCP endpoint.');
            const signals = [init?.signal, input instanceof Request ? input.signal : undefined, this.options.signal].filter((signal): signal is AbortSignal => Boolean(signal));
            const response = await fetch(input, { ...init, redirect: 'error', ...(signals.length ? { signal: AbortSignal.any(signals) } : {}) });
            if (!response.ok && response.status !== 405) {
              const code = await httpErrorCode(response, this.config.agentKey);
              const retry = response.headers.get('retry-after');
              const retryHint = retry && /^\d{1,8}$/.test(retry) ? ` Retry-After: ${retry} seconds.` : '';
              const hint = code === 'AGENT_AUDIT_UNAVAILABLE'
                ? ' The mutation may have committed before audit recording failed. Inspect current state before retrying.'
                : response.status === 429 ? ' Rate limit reached; inspect state before retrying an uncertain mutation.' : '';
              // SDK errors include HTTP response bodies. Supply a safe diagnostic body
              // instead of propagating arbitrary proxy/error pages containing secrets.
              return new Response(`HTTP ${response.status}${code ? ` (${code})` : ''}.${retryHint}${hint}`, {
                status: response.status, headers: response.headers,
              });
            }
            return response;
          },
        });
        this.transport = transport;
        try {
          // Cancel the SDK's result wait/timer too: HTTP 202 can complete fetch
          // while initialize/tools requests are still waiting for a response.
          await client.connect(transport, { signal: this.options.signal });
          if (this.closed) { await client.close(); throw new Error('Steercards runtime is closed.'); }
          this.client = client;
          return client;
        } catch (error) {
          await client.close().catch(() => {});
          if (this.transport === transport) this.transport = undefined;
          throw this.safeError(error);
        }
      })().finally(() => { this.connecting = undefined; });
    }
    return this.connecting;
  }

  async listTools({ refresh = false }: { refresh?: boolean } = {}): Promise<Tool[]> {
    if (this.closed) throw new Error('Steercards runtime is closed.');
    if (this.catalog && !refresh) return structuredClone(this.catalog);
    if (!this.listing) {
      this.listing = (async () => {
        try {
          const client = await this.connection();
          const tools: Tool[] = [];
          const cursors = new Set<string>();
          const names = new Set<string>();
          let cursor: string | undefined;
          do {
            // Avoid the SDK convenience method's output-schema compilation: a
            // proxy must accept and pass through the server's JSON Schemas.
            const page = await client.request({ method: 'tools/list', params: cursor ? { cursor } : {} }, ListToolsResultSchema, { signal: this.options.signal });
            for (const tool of page.tools) {
              if (names.has(tool.name)) throw new Error('The upstream tool catalog contains duplicate tool names.');
              names.add(tool.name);
              tools.push(tool);
            }
            cursor = page.nextCursor;
            if (cursor) {
              if (cursors.has(cursor)) throw new Error('The upstream tool catalog repeated a pagination cursor.');
              cursors.add(cursor);
            }
          } while (cursor);
          this.catalog = tools;
          return tools;
        } catch (error) { throw this.safeError(error); }
      })().finally(() => { this.listing = undefined; });
    }
    return structuredClone(await this.listing);
  }

  async searchTools(query: string, limit = 10): Promise<ToolSummary[]> {
    if (typeof query !== 'string') throw new Error('query must be a string.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100.');
    const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    // Stateless upstream servers cannot deliver catalog-change notifications.
    // An explicit discovery search therefore refreshes the current catalog.
    return (await this.listTools({ refresh: true })).map(tool => {
      const name = tool.name.toLocaleLowerCase();
      const text = `${name} ${tool.title ?? ''} ${tool.description ?? ''}`.toLocaleLowerCase();
      const score = terms.every(term => text.includes(term))
        ? terms.reduce((sum, term) => sum + (name === term ? 100 : name.includes(term) ? 10 : 1), 0) : -1;
      return { tool, score };
    }).filter(item => item.score >= 0)
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
      .slice(0, limit).map(({ tool }) => ({
        name: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        ...(tool.description ? { description: tool.description.length > 360 ? `${tool.description.slice(0, 357)}...` : tool.description } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      }));
  }

  async describeTool(name: string): Promise<Tool> {
    if (typeof name !== 'string' || !name) throw new Error('A tool name is required.');
    let tool = (await this.listTools()).find(item => item.name === name);
    // A new server tool can be called without restarting the local process.
    if (!tool) tool = (await this.listTools({ refresh: true })).find(item => item.name === name);
    if (!tool) throw new Error('Unknown Steercards tool. Search or refresh the upstream catalog.');
    return tool;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object.');
    await this.describeTool(name);
    try {
      // Low-level request deliberately preserves error results without applying an
      // outputSchema intended for successful results. No mutation retry is made.
      return await (await this.connection()).request({
        method: 'tools/call', params: { name, arguments: args },
      }, CallToolResultSchema, { signal: this.options.signal });
    } catch (error) { throw this.safeError(error); }
  }

  async close(): Promise<void> {
    this.closed = true;
    const pending = this.connecting;
    // Abort an in-flight initialize as well as established requests before
    // waiting, so closing stdio cannot leave a stalled HTTP handshake running.
    await this.transport?.close();
    if (pending) await pending.catch(() => {});
    await this.client?.close();
    this.client = undefined;
    this.transport = undefined;
    this.catalog = undefined;
  }
}
