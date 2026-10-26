import { readFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ErrorCode, ListResourcesRequestSchema,
  ListToolsRequestSchema, McpError, ReadResourceRequestSchema,
  type CallToolResult, type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { Runtime } from './runtime.js';
import { packageInfo } from './package.js';

export interface ServerOptions { mode: 'compact' | 'full' }

const guideTopics = ['overview', 'discovery', 'exploration', 'cards', 'profiles', 'claims-runs', 'context', 'files', 'collaboration'] as const;
const guideUri = 'steercards://guide/';
// Keep the work contract visible even in hosts that show tool descriptions but
// omit initialize instructions or have an older installed Skill.
const cardWorkInstructions = [
  'Before actual card work, after acquiring any required claim, call set_agent_status with status:"working" and refresh it every 5 minutes, before the 10-minute stale threshold.',
  'When waiting for a person, use status:"waiting_for_input" with the question; on a blocking error use status:"error"; resume with status:"working".',
  'Keep waiting/error visible while awaiting an answer or resolution, even when the turn ends.',
  'Call clear_agent_status before completing, abandoning or handing off the work.',
  'On claim-managed cards include the current claimFence, and clear before releasing or transferring a valid claim; after fence loss stop writing and never clear another owner\'s status.',
  'Status refresh does not renew a claim lease or send a run heartbeat.',
  'Do not create a badge for read-only lookups or assignment alone. Describe these tools for their current inputs.',
].join(' ');
const instructions = 'Steercards tools use progressive discovery. In compact mode search tool metadata, describe the selected tool to obtain its current schema, then call it with matching arguments. For directory-style card content exploration, discover explore_cards and read the exploration guide: scope a workspace, ls then rg then cat or line ranges, and continue nextCursor until complete. Use exact card lookup for known keys, search_cards for status/approval filters and archived-card inclusion, and list_participant_cards for active board cards by participant. Inspect get_board and live schemas for other property structure. Read the Steercards guide for workflows. Tool schemas are fetched from the authenticated upstream server. Respect isError and structuredContent. Never automatically retry a mutation after a network failure; read current state first. The upstream rate limit is 120 requests per minute; follow Retry-After. ' + cardWorkInstructions;

export async function getGuide(topic = 'overview'): Promise<string> {
  if (!guideTopics.includes(topic as typeof guideTopics[number])) {
    throw new Error(`Unknown guide topic. Choose ${guideTopics.join(', ')}.`);
  }
  const path = topic === 'overview' ? '../skills/steercards/SKILL.md' : `../skills/steercards/references/${topic}.md`;
  return readFile(new URL(path, import.meta.url), 'utf8');
}

const compactTools: Tool[] = [
  {
    name: 'steercards_search_tools', title: 'Search Steercards tools',
    description: 'Search the live upstream catalog by tool name and description. For directory-style card content search, find explore_cards and read the exploration guide. Returns compact metadata without schemas; describe a match before calling it. An empty query browses the catalog.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 } }, required: ['query'], additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'steercards_describe_tool', title: 'Describe a Steercards tool',
    description: 'Get the selected upstream tool’s full current metadata, inputSchema, and outputSchema. The upstream schema is the authority for arguments.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'], additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'steercards_call_tool', title: 'Call a Steercards tool',
    description: 'Call a discovered upstream tool by its exact name with a JSON arguments object. Returns the upstream content, structuredContent, and isError unchanged. May write or delete data depending on the selected tool. Never automatically retry an uncertain mutation. ' + cardWorkInstructions,
    inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 }, arguments: { type: 'object', additionalProperties: true } }, required: ['name', 'arguments'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'steercards_get_guide', title: 'Read the Steercards guide',
    description: 'Read agent workflow guidance. Start with overview, then select a topic for the task.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string', enum: [...guideTopics], default: 'overview' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
];

function jsonResult(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function stringArg(args: Record<string, unknown>, name: string): string {
  if (typeof args[name] !== 'string') throw new McpError(ErrorCode.InvalidParams, `${name} must be a string.`);
  return args[name] as string;
}

function assertKeys(args: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(args).some(key => !keys.includes(key))) throw new McpError(ErrorCode.InvalidParams, 'Unexpected argument.');
}

/** Low-level Server preserves arbitrary upstream JSON Schemas and tool metadata. */
export function createServer(runtime: Runtime, { mode }: ServerOptions): Server {
  if (mode !== 'compact' && mode !== 'full') throw new Error('Server mode must be compact or full.');
  const server = new Server({ name: packageInfo.name, version: packageInfo.version }, {
    capabilities: { tools: {}, resources: {} }, instructions,
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: mode === 'compact' ? structuredClone(compactTools) : await runtime.listTools({ refresh: true }),
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const args = request.params.arguments ?? {};
    if (mode === 'full') return runtime.callTool(request.params.name, args);
    switch (request.params.name) {
      case 'steercards_search_tools': {
        assertKeys(args, ['query', 'limit']);
        const query = stringArg(args, 'query');
        if (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 100)) {
          throw new McpError(ErrorCode.InvalidParams, 'limit must be an integer from 1 to 100.');
        }
        return jsonResult({ tools: await runtime.searchTools(query, args.limit as number | undefined) });
      }
      case 'steercards_describe_tool':
        assertKeys(args, ['name']);
        return jsonResult({ tool: await runtime.describeTool(stringArg(args, 'name')) });
      case 'steercards_call_tool': {
        assertKeys(args, ['name', 'arguments']);
        const name = stringArg(args, 'name');
        if (!args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments)) {
          throw new McpError(ErrorCode.InvalidParams, 'arguments must be a JSON object.');
        }
        return runtime.callTool(name, args.arguments as Record<string, unknown>);
      }
      case 'steercards_get_guide': {
        assertKeys(args, ['topic']);
        const topic = args.topic === undefined ? 'overview' : stringArg(args, 'topic');
        return jsonResult({ topic, guide: await getGuide(topic) });
      }
      default: throw new McpError(ErrorCode.InvalidParams, 'Unknown local tool.');
    }
  });
  // Resources cannot collide with any dynamically mirrored upstream tool name.
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: guideTopics.map(topic => ({ uri: `${guideUri}${topic}`, name: `Steercards guide: ${topic}`, mimeType: 'text/markdown' })),
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    const topic = request.params.uri.startsWith(guideUri) ? request.params.uri.slice(guideUri.length) : '';
    if (!guideTopics.includes(topic as typeof guideTopics[number])) throw new McpError(ErrorCode.InvalidParams, 'Unknown guide resource.');
    return { contents: [{ uri: request.params.uri, mimeType: 'text/markdown', text: await getGuide(topic) }] };
  });
  server.onclose = () => { void runtime.close().catch(() => {}); };
  return server;
}

export async function startServer(runtime: Runtime, options: ServerOptions): Promise<Server> {
  const server = createServer(runtime, options);
  await server.connect(new StdioServerTransport());
  // SDK 1's stdio transport does not close itself on stdin EOF. Explicitly
  // release upstream HTTP resources when the host disconnects.
  const onEnd = () => { void server.close().catch(() => {}); };
  const onClose = server.onclose;
  server.onclose = () => { process.stdin.off('end', onEnd); onClose?.(); };
  process.stdin.once('end', onEnd);
  if (process.stdin.readableEnded) onEnd();
  return server;
}
