/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The agent's language model: OpenAI, via the Responses API.
 *
 * Single source for both `server.ts` and `server/orchestrator.ts`, which each used to
 * carry their own copy of a client factory plus a retry helper.
 *
 * Everything here is optional by design. The agent must stay fully functional with no
 * model configured -- every caller falls back to canned copy -- so `generateJson` never
 * throws and returns null instead. A failed synthesis degrades the wording of a message;
 * it must never break a claim.
 */

import OpenAI from 'openai';

/**
 * Structured Outputs run in strict mode, which requires that EVERY property be listed in
 * `required` and that `additionalProperties` be false. Optionality is expressed as a union
 * with null instead. See `strictObject` / `nullable` below -- use them rather than
 * hand-writing schemas, because a schema that violates strict mode is rejected at request
 * time and the model silently falls back to canned text.
 */
export type JsonSchema = Record<string, unknown>;

/** Default model. Override with OPENAI_MODEL. */
const DEFAULT_MODEL = 'gpt-5.6';

export function modelName(): string {
  return process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
}

/**
 * MOCK_MODE gates the model as well as the outbound channels. Claim text -- claimant
 * names, loss descriptions, dollar amounts -- is sent to OpenAI on every synthesis call,
 * so a switch that promises nothing leaves the machine has to cover this too.
 */
export function isLlmConfigured(): boolean {
  if (process.env.MOCK_MODE === 'true') return false;
  const key = process.env.OPENAI_API_KEY;
  return Boolean(key && key !== 'MY_OPENAI_API_KEY' && key.trim() !== '');
}

let client: OpenAI | null = null;

/**
 * Gated on `isLlmConfigured()` rather than re-testing the key, so the LIVE/MOCK pill in
 * the header and the actual egress path can never disagree. Checked before the memo is
 * consulted, so flipping MOCK_MODE on takes effect even after a client already exists.
 */
export function getLlmClient(): OpenAI | null {
  if (!isLlmConfigured()) return null;
  if (!client) {
    try {
      client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
      console.log(`[llm] OpenAI client initialized (model: ${modelName()})`);
    } catch (err) {
      console.error('[llm] Error initializing OpenAI:', err);
    }
  }
  return client;
}

// --------------------------------------------------------------------------- schemas

/**
 * Build a strict-mode-compliant object schema: all keys required, no extra properties.
 * Strict mode has no notion of an optional key, so wrap genuinely-optional values in
 * `nullable()` and expect null rather than absence.
 */
export function strictObject(properties: Record<string, JsonSchema>): JsonSchema {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

export const str: JsonSchema = { type: 'string' };
export const num: JsonSchema = { type: 'number' };
export const int: JsonSchema = { type: 'integer' };

/** Strict mode expresses "may be absent" as a union with null. */
export function nullable(schema: JsonSchema): JsonSchema {
  const t = schema.type;
  return { ...schema, type: Array.isArray(t) ? t : [t, 'null'] };
}

export function arrayOf(items: JsonSchema): JsonSchema {
  return { type: 'array', items };
}

// --------------------------------------------------------------------------- generation

export interface GenerateJsonOptions {
  /** The instruction sent to the model. */
  prompt: string;
  /** Schema identifier reported to the API; useful in logs. */
  schemaName: string;
  /** Must be strict-mode compliant -- build it with `strictObject`. */
  schema: JsonSchema;
  maxRetries?: number;
  /** Label used in log lines so a failure can be traced to a call site. */
  label?: string;
}

/**
 * Ask the model for JSON matching `schema`.
 *
 * Returns null -- never throws -- when the model is unconfigured, the request fails after
 * retries, or the response does not parse. Callers are expected to have canned fallbacks.
 * Transient failures (429 / 5xx / network) get exponential backoff.
 */
export async function generateJson<T = unknown>(opts: GenerateJsonOptions): Promise<T | null> {
  const openai = getLlmClient();
  if (!openai) return null;

  const label = opts.label ?? opts.schemaName;
  const maxRetries = opts.maxRetries ?? 4;
  let delay = 1000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await openai.responses.create({
        model: modelName(),
        input: opts.prompt,
        text: {
          format: {
            type: 'json_schema',
            name: opts.schemaName,
            schema: opts.schema as any,
            strict: true,
          },
        },
      });

      const text = response.output_text;
      if (!text || !text.trim()) {
        console.warn(`[llm] ${label}: empty response`);
        return null;
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        // Strict mode should make this unreachable; treat it as a hard failure rather
        // than retrying, since a well-formed request produced malformed output.
        console.error(`[llm] ${label}: response was not valid JSON despite strict mode`);
        return null;
      }
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status;
      const transient = status === 429 || (typeof status === 'number' && status >= 500) || !status;
      if (attempt >= maxRetries || !transient) {
        console.error(`[llm] ${label} failed: ${err?.message ?? err}`);
        return null;
      }
      console.warn(`[llm] ${label}: retrying (attempt ${attempt}/${maxRetries}) after ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    }
  }

  return null;
}
