/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Email channel adapter — sends via a tool on a remote Composio MCP server.
 *
 * Unlike Sendblue there is no fixed REST contract here: which email tool the Composio
 * server exposes (Gmail, Outlook, ...) depends on what the account has connected. So the
 * adapter discovers the send-email tool at connect time and maps its own {to, subject,
 * body} onto whatever input schema it finds.
 *
 * Credentials are read from process.env only — never hardcoded, never defaulted.
 * With no credentials (or MOCK_MODE=true) sends are logged and synthetically succeeded.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface SendEmailOptions {
  to: string;
  subject: string;
  /** Plain-text body; the adapter wraps it in light HTML for Gmail (`is_html`). */
  body: string;
  /** When false, send body as plain text. Default true. */
  rich?: boolean;
}

export interface SendEmailResult {
  ok: boolean;
  mock: boolean;
  messageId?: string;
  threadId?: string;
  error?: string;
}

interface DiscoveredTool {
  name: string;
  inputSchema: Record<string, unknown> | undefined;
}

interface EmailBinding {
  client: Client;
  tool: DiscoveredTool;
}

/**
 * True only when both env vars are present and mock mode has not been forced.
 * The UI's vendor-status indicator reads this.
 */
export function isLive(): boolean {
  if (process.env.MOCK_MODE === 'true') return false;
  return Boolean(process.env.COMPOSIO_MCP_URL?.trim() && process.env.COMPOSIO_MCP_API_KEY?.trim());
}

/** Mock message ids are sequential rather than random so logs/tests stay reproducible. */
let mockSendCounter = 0;

/**
 * Memoized connection. Connecting + listing tools is expensive, so it is done once and
 * shared; a failed send clears the memo so the next call reconnects.
 */
let bindingPromise: Promise<EmailBinding> | null = null;

/** Tool names we've seen in the wild, tried before falling back to fuzzy matching. */
const KNOWN_TOOL_NAMES = [
  'GMAIL_SEND_EMAIL',
  'OUTLOOK_SEND_EMAIL',
  'GMAIL_SEND_DRAFT',
  'SENDGRID_SEND_EMAIL'
];

/**
 * Pick the send-email tool from whatever the server exposes.
 * Exact known names win; otherwise any tool whose name mentions both "send" and
 * "email"/"mail" is accepted. Returns null so the caller can log the full tool list.
 */
function selectEmailTool(tools: DiscoveredTool[]): DiscoveredTool | null {
  for (const known of KNOWN_TOOL_NAMES) {
    const hit = tools.find(t => t.name.toUpperCase() === known);
    if (hit) return hit;
  }
  return (
    tools.find(t => {
      const n = t.name.toLowerCase();
      return n.includes('send') && (n.includes('email') || n.includes('mail'));
    }) ?? null
  );
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** "Key: Value" lines become a compact fact table; everything else becomes paragraphs. */
function renderBodyBlocks(plain: string): string {
  const blocks = plain
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map(b => b.trim())
    .filter(Boolean);

  return blocks
    .map(block => {
      const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
      const looksLikeFacts =
        lines.length >= 2 && lines.every(l => /^[A-Za-z][\w\s/-]{0,40}:\s+\S/.test(l));

      if (looksLikeFacts) {
        const rows = lines
          .map(line => {
            const i = line.indexOf(':');
            const key = escapeHtml(line.slice(0, i).trim());
            const val = escapeHtml(line.slice(i + 1).trim());
            return (
              `<tr>` +
              `<td style="padding:6px 12px 6px 0;color:#64748b;font-size:13px;white-space:nowrap;vertical-align:top;">${key}</td>` +
              `<td style="padding:6px 0;color:#0f172a;font-size:13px;font-weight:600;">${val}</td>` +
              `</tr>`
            );
          })
          .join('');
        return (
          `<table role="presentation" cellpadding="0" cellspacing="0" ` +
          `style="width:100%;margin:16px 0;border-collapse:collapse;` +
          `background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">` +
          `<tr><td style="padding:12px 16px;"><table role="presentation" cellpadding="0" cellspacing="0">${rows}</table></td></tr>` +
          `</table>`
        );
      }

      const html = lines.map(escapeHtml).join('<br/>');
      return `<p style="margin:0 0 14px;color:#334155;font-size:15px;line-height:1.55;">${html}</p>`;
    })
    .join('');
}

/**
 * Light rich HTML shell for claim emails — header accent, readable body, soft footer.
 * Input is plain text from the orchestrator (never trust raw HTML from the model).
 */
export function formatRichEmailHtml(subject: string, plainBody: string): string {
  const title = escapeHtml(subject);
  const content = renderBodyBlocks(plainBody);

  return (
    `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f1f5f9;">` +
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;` +
    `max-width:560px;margin:0 auto;padding:24px 16px;">` +
    `<div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">` +
    `<div style="height:4px;background:linear-gradient(90deg,#2563eb,#0ea5e9);"></div>` +
    `<div style="padding:22px 24px 8px;">` +
    `<div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;font-weight:600;margin-bottom:6px;">Conquer</div>` +
    `<div style="font-size:18px;font-weight:700;color:#0f172a;line-height:1.3;margin-bottom:18px;">${title}</div>` +
    `${content}` +
    `</div>` +
    `<div style="padding:14px 24px 20px;border-top:1px solid #f1f5f9;">` +
    `<p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.45;">` +
    `Sent by Conquer claims agent · Please reply to this email if you have questions.` +
    `</p></div></div></div></body></html>`
  );
}

/**
 * Map our fields onto the discovered tool's input schema.
 *
 * Field names are guessed from the schema's property list using the alias tables below.
 * If the discovered tool uses names outside these lists, the logged input schema
 * (printed on first connect) shows exactly what to add here.
 */
function mapEmailArgs(tool: DiscoveredTool, options: SendEmailOptions): Record<string, unknown> {
  const properties = (tool.inputSchema?.properties as Record<string, unknown> | undefined) ?? {};
  const schemaKeys = Object.keys(properties);

  // Pick the first alias the schema actually declares; if the schema is unknown/empty,
  // fall back to the first alias so we still send something plausible.
  const pick = (aliases: string[]): string =>
    aliases.find(a => schemaKeys.some(k => k.toLowerCase() === a.toLowerCase())) ?? aliases[0];

  const toKey = pick(['recipient_email', 'to', 'to_email', 'recipients', 'toRecipients']);
  const subjectKey = pick(['subject', 'title']);
  const bodyKey = pick(['body', 'message_body', 'text', 'content', 'message']);
  const htmlFlagKey = schemaKeys.find(k => {
    const n = k.toLowerCase();
    return n === 'is_html' || n === 'ishtml' || n === 'html';
  });

  // Some schemas type the recipient as an array of addresses rather than a string.
  const toSchema = properties[toKey] as { type?: string } | undefined;
  const toValue = toSchema?.type === 'array' ? [options.to] : options.to;

  const useRich = options.rich !== false;
  const body = useRich ? formatRichEmailHtml(options.subject, options.body) : options.body;

  const args: Record<string, unknown> = {
    [toKey]: toValue,
    [subjectKey]: options.subject,
    [bodyKey]: body,
  };

  if (useRich && htmlFlagKey) {
    args[htmlFlagKey] = true;
  }

  return args;
}

async function connectAndDiscover(): Promise<EmailBinding> {
  const url = process.env.COMPOSIO_MCP_URL!.trim();
  const apiKey = process.env.COMPOSIO_MCP_API_KEY!.trim();

  // Composio rejects dual auth (401 code 10401): exactly one mode per request.
  // COMPOSIO_MCP_API_KEY is an API key → ApiKeyAuth via x-api-key only.
  // If you ever switch to a project JWT, send Authorization: Bearer <jwt> instead
  // and omit x-api-key (never send both).
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        'x-api-key': apiKey,
      },
    },
  });

  const client = new Client({ name: 'conquer-claim-agent', version: '1.0.0' });
  await client.connect(transport);

  const listed = await client.listTools();
  const tools: DiscoveredTool[] = (listed.tools ?? []).map(t => ({
    name: t.name,
    inputSchema: t.inputSchema as Record<string, unknown> | undefined
  }));

  const tool = selectEmailTool(tools);
  if (!tool) {
    await client.close().catch(() => {});
    const names = tools.map(t => t.name).join(', ') || '(none)';
    console.error(`[Email] No send-email tool found on Composio MCP server. Available tools: ${names}`);
    throw new Error(`No send-email tool found on Composio MCP server. Available tools: ${names}`);
  }

  // Logged once per connect so a human can see what was matched and correct mapEmailArgs.
  console.log(`[Email] Discovered send-email tool "${tool.name}" out of ${tools.length} tool(s).`);
  console.log(`[Email] "${tool.name}" input schema: ${JSON.stringify(tool.inputSchema ?? {})}`);

  return { client, tool };
}

function getBinding(): Promise<EmailBinding> {
  if (!bindingPromise) {
    bindingPromise = connectAndDiscover().catch(err => {
      bindingPromise = null; // don't cache a failed connect
      throw err;
    });
  }
  return bindingPromise;
}

/** Best-effort extraction of ids from the tool's (provider-shaped) response. */
function extractIds(result: unknown): { messageId?: string; threadId?: string } {
  const seen: Record<string, unknown> = {};
  const walk = (node: unknown, depth: number) => {
    if (depth > 5 || !node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const k = key.toLowerCase();
      if ((k === 'id' || k === 'messageid' || k === 'message_id') && seen.messageId === undefined) {
        if (typeof value === 'string') seen.messageId = value;
      }
      if ((k === 'threadid' || k === 'thread_id') && seen.threadId === undefined) {
        if (typeof value === 'string') seen.threadId = value;
      }
      if (typeof value === 'object') walk(value, depth + 1);
    }
  };
  walk(result, 0);
  return { messageId: seen.messageId as string | undefined, threadId: seen.threadId as string | undefined };
}

/**
 * Send an email. Never throws — always resolves to a result object so the orchestrator
 * can decide whether to retry, escalate, or fall back to another channel.
 */
export async function sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
  if (!isLive()) {
    mockSendCounter++;
    console.log(
      `[Email][MOCK] Would send email (${options.rich === false ? 'plain' : 'rich HTML'}):\n` +
        `  to: ${options.to}\n  subject: ${options.subject}\n  body: ${options.body}`
    );
    return { ok: true, mock: true, messageId: `mock-email-${mockSendCounter}` };
  }

  try {
    const { client, tool } = await getBinding();
    const args = mapEmailArgs(tool, options);

    const result = await client.callTool({ name: tool.name, arguments: args });

    if ((result as { isError?: boolean }).isError) {
      bindingPromise = null; // force a fresh connect + rediscovery next time
      const detail = JSON.stringify((result as { content?: unknown }).content ?? result).slice(0, 400);
      console.error(`[Email] Tool "${tool.name}" reported an error: ${detail}`);
      return { ok: false, mock: false, error: `Composio tool "${tool.name}" failed: ${detail}` };
    }

    const ids = extractIds((result as { structuredContent?: unknown }).structuredContent ?? result);
    console.log(`[Email] Sent to ${options.to} via "${tool.name}" (id=${ids.messageId ?? 'none'})`);
    return { ok: true, mock: false, ...ids };
  } catch (err: any) {
    // Covers connect failures, discovery failures, and dropped sessions. Clearing the
    // memo means the next send reconnects rather than reusing a dead client.
    bindingPromise = null;
    const message = err?.message ?? String(err);
    console.error(`[Email] Send to ${options.to} failed: ${message}`);
    return { ok: false, mock: false, error: message };
  }
}
