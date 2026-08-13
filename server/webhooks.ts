/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Inbound provider webhooks -- the other half of the long-horizon loop. The orchestrator
 * parks a claim on an outbound contact; these routes are how the reply gets back in.
 *
 * Signature verification status per route:
 *   POST /webhooks/sendblue/inbound            NOT verified. Sendblue's free tier issues
 *                                              no signing secret, so this endpoint trusts
 *                                              its caller. Put it behind a proxy or a
 *                                              secret path segment before exposing it.
 *   POST /webhooks/elevenlabs/call-started     NOT verified. Informational only: it never
 *                                              mutates claim state.
 *   POST /webhooks/elevenlabs/transcript       VERIFIED (HMAC via verifyWebhookSignature).
 *   POST /webhooks/elevenlabs/callback         VERIFIED (HMAC via verifyWebhookSignature).
 * The two state-changing ElevenLabs routes are both verified; the brief only asked for the
 * callback, but `transcript` resolves a sub-step too, so leaving it open would be a hole.
 *
 * !! MOUNT ORDER !! HMAC verification needs the exact request bytes. The ElevenLabs routes
 * mount their own catch-all `express.raw` parser, but Express body parsers are
 * first-one-wins: if a global `app.use(express.json())` has already consumed the stream,
 * the route-level raw parser is skipped and `req.body` arrives as a parsed object.
 * `registerWebhookRoutes(app)` MUST therefore be called BEFORE `app.use(express.json())`
 * in server.ts. When it isn't, the handlers log a loud error and fall back to
 * re-serializing the parsed body, which will not byte-match the provider's signature --
 * so a configured secret means those requests get a 401 rather than being waved through.
 */

import express from 'express';
import { store } from './mongo.js';
import * as sendblue from './channels/sendblue.js';
import * as elevenlabs from './channels/elevenlabs.js';
import { resolveAwaitingContact, ResolveOutcome } from './orchestrator.js';

/** Surface every webhook on the dashboard's log + pub/sub panes. */
async function trace(level: 'INFO' | 'ERROR', message: string, event?: string): Promise<void> {
  store.log(level, message);
  if (event) await store.publish('claims:pubsub', event);
}

/**
 * Recover the raw request bytes when possible. Returns the Buffer if a raw parser ran,
 * otherwise re-serializes the already-parsed body and flags the mount-order problem.
 */
function rawBodyOf(req: express.Request): { raw: Buffer | string; exact: boolean } {
  if (Buffer.isBuffer(req.body)) return { raw: req.body, exact: true };
  return { raw: JSON.stringify(req.body ?? {}), exact: false };
}

/** Whatever the parser left us, get back to a JS object for the payload parsers. */
function jsonBodyOf(req: express.Request): unknown {
  if (!Buffer.isBuffer(req.body)) return req.body;
  try {
    return JSON.parse(req.body.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Translate a resolve outcome into a status code.
 *
 * - applied / ignored -> 200. Nothing more will change by retrying, and a retry storm on a
 *   duplicate or an unmatched sender is pure noise.
 * - contended -> 503 + Retry-After. Another delivery held the claim mutex, so this event
 *   genuinely has NOT been processed and the provider SHOULD send it again. Answering 200
 *   here is what silently dropped it before: ElevenLabs emits a transcript and a post-call
 *   callback for the same conversation, so two distinct events racing is routine.
 */
function respondToOutcome(res: express.Response, outcome: ResolveOutcome): express.Response {
  if (outcome.status === 'contended') {
    return res.status(503).set('Retry-After', '2').json({ ok: false, retry: true, reason: 'claim busy' });
  }
  return res.status(200).json({
    ok: true,
    applied: outcome.status === 'applied',
    ...(outcome.status === 'ignored' ? { reason: outcome.reason } : {}),
  });
}

export function registerWebhookRoutes(app: express.Express): void {
  // -------------------------------------------------------------- Sendblue SMS
  // Inbound SMS / iMessage replies. Matched to a claim by the sender's phone number,
  // normalized to E.164 on both sides by the sendblue adapter.
  app.post('/webhooks/sendblue/inbound', express.json(), async (req, res) => {
    try {
      const parsed = sendblue.parseInboundWebhook(req.body);
      if (!parsed) {
        // Also the shape of a delivery-status callback, which is not an error worth
        // retrying -- but it is unparseable *as an inbound message*, so say so.
        await trace('INFO', 'Sendblue webhook ignored: not a recognizable inbound message');
        return res.status(400).json({ ok: false, error: 'Unrecognized Sendblue inbound payload' });
      }

      await trace(
        'INFO',
        `WEBHOOK sendblue/inbound from ${parsed.fromPhone} via ${parsed.service ?? 'unknown'}: "${parsed.text}"`,
        `WEBHOOK_IN:sms:${parsed.fromPhone}`
      );

      const outcome = await resolveAwaitingContact({
        channel: 'sms',
        lookupValue: parsed.fromPhone,
        replyText: parsed.text,
        eventId: parsed.eventId,
        // A genuine provider webhook is the only thing entitled to claim 'inbound'.
        replySource: 'inbound',
      });

      return respondToOutcome(res, outcome);
    } catch (err: any) {
      await trace('ERROR', `sendblue/inbound handler failed: ${err?.message || err}`);
      return res.status(500).json({ ok: false, error: 'Internal error' });
    }
  });

  // -------------------------------------------------- ElevenLabs: call started
  // Informational: the call is still in progress, so there is no reply to apply yet.
  // Annotates the dashboard only.
  app.post('/webhooks/elevenlabs/call-started', express.json(), async (req, res) => {
    try {
      const parsed = elevenlabs.parseCallWebhook(req.body);
      if (!parsed) {
        await trace('INFO', 'ElevenLabs call-started webhook ignored: unrecognized payload');
        return res.status(400).json({ ok: false, error: 'Unrecognized ElevenLabs payload' });
      }
      await trace(
        'INFO',
        `WEBHOOK elevenlabs/call-started conversation=${parsed.conversationId} type=${parsed.eventType}` +
          `${parsed.status ? ` status=${parsed.status}` : ''}`,
        `WEBHOOK_IN:call_started:${parsed.conversationId}`
      );
      return res.status(200).json({ ok: true, applied: false });
    } catch (err: any) {
      await trace('ERROR', `elevenlabs/call-started handler failed: ${err?.message || err}`);
      return res.status(500).json({ ok: false, error: 'Internal error' });
    }
  });

  // ------------------------------ ElevenLabs: transcript + post-call callback
  // Both carry the finished conversation and resolve the awaiting sub-step, so both are
  // signature-verified and both need the raw body (see the MOUNT ORDER note above).
  const resolveCall = (routeLabel: string) => async (req: express.Request, res: express.Response) => {
    try {
      const { raw, exact } = rawBodyOf(req);
      if (!exact) {
        await trace(
          'ERROR',
          `${routeLabel}: raw request body unavailable (a global express.json() ran first). ` +
            'Call registerWebhookRoutes(app) BEFORE app.use(express.json()) or HMAC verification cannot pass.'
        );
      }

      const signature = req.header('elevenlabs-signature') ?? req.header('ElevenLabs-Signature');
      if (!elevenlabs.verifyWebhookSignature(raw, signature)) {
        await trace('ERROR', `${routeLabel}: rejected, invalid signature`);
        return res.status(401).json({ ok: false, error: 'Invalid signature' });
      }

      const parsed = elevenlabs.parseCallWebhook(jsonBodyOf(req));
      if (!parsed) {
        await trace('INFO', `${routeLabel} ignored: unrecognized payload`);
        return res.status(400).json({ ok: false, error: 'Unrecognized ElevenLabs payload' });
      }

      await trace(
        'INFO',
        `WEBHOOK ${routeLabel} conversation=${parsed.conversationId} type=${parsed.eventType}` +
          `${parsed.transcript ? ` turns=${parsed.transcript.length}` : ''}`,
        `WEBHOOK_IN:call:${parsed.conversationId}`
      );

      const hydrated = await elevenlabs.hydrateCallWebhook(parsed);

      // Do not advance the timeline on missed/no-answer/failed calls — those still
      // produce post-call webhooks, and treating them as success dialed the next
      // contact while the first call was still "in progress" from the user's view.
      const gate = elevenlabs.isCallCompleteForProgression(hydrated);
      if (!gate.complete) {
        await trace(
          'INFO',
          `${routeLabel}: not advancing — ${gate.reason} (conversation=${hydrated.conversationId})`
        );
        return res.status(200).json({ ok: true, applied: false, reason: gate.reason });
      }

      const outcome = await resolveAwaitingContact({
        channel: 'call',
        lookupValue: hydrated.conversationId,
        transcript: hydrated.transcript,
        // Prefer real transcript turns; only fall back to summary when it is not the
        // empty "couldn't be generated" placeholder ElevenLabs emits on missed calls.
        // A connected hangup still needs *some* text or resolveAwaitingContact ignores it.
        replyText:
          hydrated.transcript && hydrated.transcript.length > 0
            ? undefined
            : hydrated.summary && !/summary couldn't be generated/i.test(hydrated.summary)
              ? hydrated.summary
              : 'Call ended; the recipient disconnected.',
        eventId: parsed.eventId,
        // Signature-verified provider callback with recipient speech.
        replySource: 'inbound',
      });

      return respondToOutcome(res, outcome);
    } catch (err: any) {
      await trace('ERROR', `${routeLabel} handler failed: ${err?.message || err}`);
      return res.status(500).json({ ok: false, error: 'Internal error' });
    }
  };

  app.post('/webhooks/elevenlabs/transcript', express.raw({ type: '*/*' }), resolveCall('elevenlabs/transcript'));
  app.post('/webhooks/elevenlabs/callback', express.raw({ type: '*/*' }), resolveCall('elevenlabs/callback'));

  store.log('INFO', 'Webhook routes registered: /webhooks/sendblue/inbound, /webhooks/elevenlabs/{call-started,transcript,callback}');
}
