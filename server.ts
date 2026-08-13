/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { Claim, DbKeyInfo, DbLog, DbPubSubMsg, TimelineStep, SubStep, ChatMessage } from './src/types.js';
import { store, initDb, isDbReady } from './server/mongo.js';
import {
  advanceClaim,
  resolveAwaitingSubStep,
  finalizeClaim,
  getAwaiting,
  getVendorStatus,
  pollSmsInboxFallback,
  pollCallCompletionFallback,
  synthesizeReply,
  stopActiveClaim,
  withClaimLock,
} from './server/orchestrator.js';
import {
  archiveActiveSession,
  beginSession,
  getSession,
  listSessionSummaries,
  saveSessionSnapshot,
} from './server/sessions.js';
import { forgetAll, initMemory, listMemories, memoryStatus } from './server/memory.js';
import {
  initCheckpoints,
  listCheckpoints,
  recoverOnBoot,
  restoreCheckpoint,
} from './server/checkpoints.js';
import { registerWebhookRoutes } from './server/webhooks.js';
import * as smsChannel from './server/channels/sendblue.js';
import { generateJson, isLlmConfigured, modelName, strictObject, arrayOf, nullable, str, num, int } from './server/llm.js';

// Load environment variables
dotenv.config();

/**
 * Express 4 does not catch rejections from async handlers, and Node >= 15 turns an
 * unhandled rejection into process exit -- so a single bad value in MongoDB could kill the
 * server. (Reproduced: `SET claims:active oops` from the dashboard CLI, then Execute Step.)
 * Every async route is wrapped so a failure becomes a 500 instead of a crash.
 */
function asyncRoute(
  handler: (req: express.Request, res: express.Response) => Promise<unknown>
): express.RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res)).catch(err => {
      console.error(`[route] ${req.method} ${req.path} failed:`, err);
      store.log('ERROR', `${req.method} ${req.path} failed: ${err?.message || err}`);
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
      else next(err);
    });
  };
}

/**
 * Narrow an arbitrary stored value to a Claim. `claims:active` is editable through the
 * shipped dashboard CLI, so it can legitimately hold a string or a partial object; the old
 * `if (!claim)` check passed any truthy value straight into code that indexes `timeline`.
 */
function asClaim(value: unknown): Claim | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Partial<Claim>;
  if (typeof c.id !== 'string' || !Array.isArray(c.timeline)) return null;
  return value as Claim;
}

// A crash-proofed route still cannot cover a stray rejection from a background task, and
// dying mid-write is how a claim ends up wedged. Log loudly and keep serving.
process.on('unhandledRejection', reason => {
  console.error('[fatal-guard] Unhandled rejection (server kept alive):', reason);
});

const app = express();
// Hosts (Railway, Render, Fly, Heroku) assign a port and route to it, so $PORT must win.
// Falls back to 3000 for local development.
const PORT = Number(process.env.PORT) || 3000;

// MOUNT ORDER MATTERS: the ElevenLabs webhooks verify an HMAC over the exact request
// bytes, and Express body parsers are first-one-wins. These must be registered before
// the global express.json() below or the raw body is gone and signatures cannot match.
registerWebhookRoutes(app);

app.use(express.json());

// Platform healthcheck (Railway/Render/Fly poll this before routing traffic). Reports
// MongoDB reachability, since the app cannot serve a claim without it.
app.get('/healthz', (req, res) => {
  const ok = isDbReady();
  res.status(ok ? 200 : 503).json({ ok, mongodb: ok ? 'connected' : 'not connected' });
});

// --- Agent memory + checkpoints -------------------------------------------------------
// The two halves of "no cold start": `agent_memory` is what the agent learned on earlier
// claims, `checkpoints` is where the current one had got to. Both are read-only here apart
// from the explicit forget/restore operations.

app.get('/api/agent/memory', asyncRoute(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 40, 200);
  res.json({ status: await memoryStatus(), memories: await listMemories(limit) });
}));

// Wipes long-term memory only. Deliberately NOT part of FLUSHALL: clearing claim state and
// making the agent forget everything it has ever learned are different decisions.
app.post('/api/agent/memory/forget', asyncRoute(async (_req, res) => {
  res.json({ forgotten: await forgetAll() });
}));

app.get('/api/agent/checkpoints', asyncRoute(async (req, res) => {
  const threadId = typeof req.query.threadId === 'string' ? req.query.threadId : undefined;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json({ checkpoints: await listCheckpoints(threadId, limit) });
}));

// Rewind the live claim to an earlier transition. Restores state and the awaiting/lookup
// keys; sends nothing, so no contact is re-fired by a restore.
app.post('/api/claims/checkpoints/:checkpointId/restore', asyncRoute(async (req, res) => {
  const claim = await restoreCheckpoint(req.params.checkpointId);
  if (!claim) return res.status(404).json({ error: 'No such checkpoint' });
  res.json({ claim, awaiting: await getAwaiting() });
}));

// Mock default claims
const DEFAULT_CLAIMS: Record<string, Claim> = {
  'sarah_jenkins': {
    id: 'claim:1001',
    claimantName: 'Bharat Bhavnasi',
    claimType: 'Medical Prior-Authorization',
    claimAmount: 18450.00,
    status: 'INTAKE',
    policyNumber: 'MED-7729-JE',
    description: 'Bilateral meniscus tear sustained during physical training. Orthopedic specialist recommends arthroscopy & recovery program.',
    currentStepIndex: 0,
    version: 0,
    timeline: [
      {
        id: 'step_1',
        timeLabel: 'Day 1',
        signal: 'Prior authorization required for follow-up procedure',
        agentMemory: 'The procedure, referral, appointment, and authorization requirement remain connected.',
        status: 'active',
        subSteps: [
          {
            id: 'sub_1_1',
            type: 'horizon',
            systemName: 'Conquer',
            techType: 'Workflow',
            description: 'Starts the prior authorization check'
          },
          {
            id: 'sub_1_2',
            type: 'api',
            systemName: 'Payer portal',
            techType: 'API',
            description: 'Checks status and evidence requirements'
          },
          {
            id: 'sub_1_3',
            type: 'phone',
            systemName: 'Payer',
            techType: 'Phone',
            description:
              'Collect from payer: (1) prior-auth status, (2) if pending/denied the exact clinical evidence still required, (3) any auth/case reference number',
            chatLog: [
              {
                sender: 'agent',
                name: 'Agent',
                text:
                  'Hi, this is Conquer calling the payer desk about prior authorization for Bharat Bhavnasi, claim 1001. What is the current authorization status, and if it is not approved, what clinical evidence do you still need?',
              },
              {
                sender: 'recipient',
                name: 'Payer representative',
                text:
                  'The authorization is pending. We need additional clinical evidence supporting the need for immediate surgery — specifically the MRI report and the orthopedic specialist notes.',
              },
            ],
          },
          {
            id: 'sub_1_4',
            type: 'tool',
            systemName: 'Data platform',
            techType: 'Tool',
            description: 'Records the additional evidence requirement'
          }
        ]
      },
      {
        id: 'step_2',
        timeLabel: '+5 minutes',
        signal: 'Routes the evidence request to the provider',
        agentMemory: 'The provider\'s department extension is 2234.',
        status: 'pending',
        subSteps: [
          {
            id: 'sub_2_1',
            type: 'horizon',
            systemName: 'Conquer',
            techType: 'Workflow',
            description: 'Identifies the provider and prepares the evidence request'
          },
          {
            id: 'sub_2_2',
            type: 'api',
            systemName: 'EHR',
            techType: 'Workflow',
            description: 'Opens the linked evidence request'
          },
          {
            id: 'sub_2_3',
            type: 'phone',
            systemName: 'Provider',
            techType: 'Phone',
            description: 'Provides the requested clinical evidence',
            chatLog: [
              {
                sender: 'agent',
                name: 'Agent',
                text: 'Hi, this is Conquer calling the provider office about Bharat Bhavnasi, claim 1001. The payer asked for additional clinical evidence for the surgery authorization — can you help get that submitted?',
              },
              {
                sender: 'recipient',
                name: 'Clinic Coordinator',
                text: 'I have the supporting clinical notes and post-MRI reports. I will upload them directly to the EHR portal now.',
              },
            ],
          }
        ]
      },
      {
        id: 'step_3',
        timeLabel: 'Day 2',
        signal: 'Additional evidence submitted for prior authorization',
        agentMemory: 'The submitted evidence, procedure, payer request, and appointment history remain active context.',
        status: 'pending',
        subSteps: [
          {
            id: 'sub_3_1',
            type: 'horizon',
            systemName: 'Conquer',
            techType: 'Workflow',
            description: 'Checks the updated payer determination'
          },
          {
            id: 'sub_3_2',
            type: 'api',
            systemName: 'Payer portal',
            techType: 'API',
            description: 'Retrieves the updated decision'
          },
          {
            id: 'sub_3_3',
            type: 'api',
            systemName: 'EHR',
            techType: 'Workflow',
            description: 'Updates the procedure record'
          },
          {
            id: 'sub_3_4',
            type: 'phone',
            systemName: 'Payer',
            techType: 'Phone',
            description: 'Approves the prior authorization',
            chatLog: [
              { sender: 'agent', name: 'Agent', text: 'I am checking the status of the authorization with the additional evidence submitted.' },
              { sender: 'recipient', name: 'Payer System', text: 'The clinical evidence is complete. The prior authorization is approved. Approval Code: AUT-9981-A.' }
            ]
          }
        ]
      },
      {
        id: 'step_4',
        timeLabel: '+45 minutes',
        signal: 'Prior authorization approved',
        agentMemory: 'The patient prefers SMS and Thursdays.',
        status: 'pending',
        subSteps: [
          {
            id: 'sub_4_1',
            type: 'horizon',
            systemName: 'Conquer',
            techType: 'Workflow',
            description: 'Applies the saved patient preferences'
          },
          {
            id: 'sub_4_2',
            type: 'api',
            systemName: 'Scheduling',
            techType: 'Workflow',
            description: 'Books a Thursday slot and sends SMS confirmation'
          },
          {
            id: 'sub_4_3',
            type: 'sms',
            systemName: 'Patient',
            techType: 'SMS',
            description: 'Confirms the Thursday appointment',
            chatLog: [
              { sender: 'agent', name: 'Agent', text: 'Your meniscus surgery authorization is approved. I can book the follow-up for Thursday morning.' },
              { sender: 'recipient', name: 'Patient (Bharat)', text: 'Thursday morning works for me. Please book it.' }
            ]
          },
          {
            id: 'sub_4_4',
            type: 'outcome',
            systemName: 'Outcome',
            techType: 'Calendar',
            description: 'Appointment booked successfully'
          }
        ]
      }
    ]
  },
  'marcus_vance': {
    id: 'claim:1002',
    claimantName: 'Bharat Bhavnasi',
    claimType: 'Auto Collision Claim',
    // Starts at the shop's initial estimate; live shop negotiation overwrites this with
    // whatever total the shop person agrees to on the call (even a $1 concession).
    claimAmount: 9200.00,
    initialShopQuote: 9200.00,
    status: 'INTAKE',
    policyNumber: 'AUT-2810-VA',
    description: 'Collision with structural road debris on highway. Front bumper, headlights, and active driving sensors destroyed.',
    currentStepIndex: 0,
    version: 0,
    timeline: [
      {
        id: 'step_1',
        timeLabel: 'Day 1',
        signal: 'Auto accident claim lodged & police log pulled',
        agentMemory: 'Bharat is covered under comprehensive policy with $500 deductible. Auto-rental is covered. Vehicle towed to Westside Auto Body.',
        status: 'active',
        subSteps: [
          { id: 'sub_1_1', type: 'horizon', systemName: 'Conquer', techType: 'Workflow', description: 'Triggers claim registry & policy confirmation' },
          { id: 'sub_1_2', type: 'api', systemName: 'Registry', techType: 'API', description: 'Checks driver record & validation status' },
          {
            id: 'sub_1_3',
            type: 'phone',
            systemName: 'Claimant',
            techType: 'Phone',
            description: 'Validates crash details and tow destination',
            chatLog: [
              {
                sender: 'agent',
                name: 'Agent',
                text: 'Hi Bharat, this is Conquer calling about your road-debris collision claim AUT-2810-VA. Was the vehicle towed, and which shop has it?',
              },
              {
                sender: 'recipient',
                name: 'Bharat',
                text: 'Yes, the car was towed to Westside Auto Body. The bumper is completely detached and the front sensors look smashed.',
              },
            ],
          },
          {
            id: 'sub_1_4',
            type: 'custom',
            systemName: 'Claimant inbox',
            techType: 'Email',
            description: 'Emails claim confirmation and next-step checklist',
            chatLog: [
              {
                sender: 'agent',
                name: 'Agent',
                text:
                  'Subject: Claim confirmation — Bharat Bhavnasi (AUT-2810-VA)\n\n' +
                  'Hi Bharat,\n\n' +
                  'We have opened your auto collision claim. Deductible $500; rental coverage is active.\n\n' +
                  'Next: we will contact Westside Auto Body for inspection and send your rental details.\n\n' +
                  'Claim: claim:1002\n' +
                  'Policy: AUT-2810-VA\n' +
                  'Deductible: $500\n\n' +
                  '— Conquer claims agent',
              },
            ],
          },
        ],
      },
      {
        id: 'step_2',
        timeLabel: '+15 minutes',
        signal: 'Dispatch repair assessor and rental vehicle',
        agentMemory: 'Repair shop in Westside is in-network. Dispatching rental matching preferred mid-size class.',
        status: 'pending',
        subSteps: [
          { id: 'sub_2_1', type: 'horizon', systemName: 'Conquer', techType: 'Workflow', description: 'Authorizes immediate parts check and tow receipt clearance' },
          { id: 'sub_2_2', type: 'api', systemName: 'Assessor Portal', techType: 'Workflow', description: 'Dispatches digital inspection job to Westside Auto Body' },
          {
            id: 'sub_2_3',
            type: 'sms',
            systemName: 'Claimant',
            techType: 'SMS',
            description: 'Sends rental reservation details',
            chatLog: [
              {
                sender: 'agent',
                name: 'Agent',
                text: 'Bharat — Hertz mid-size rental authorized while Westside repairs your vehicle. Reservation RNT-4410. Reply YES if that works.',
              },
              { sender: 'recipient', name: 'Bharat', text: 'YES — I will pick it up this afternoon. Thanks!' },
            ],
          },
        ],
      },
      {
        id: 'step_3',
        timeLabel: 'Day 2',
        signal: 'Shop estimate discussion, concession & OEM sensor waiver',
        agentMemory:
          'Policy covers aftermarket parts except primary safety camera sensors (OEM required). Initial shop quote came in high — adjuster should seek a network-rate labor match and a price concession before locking the estimate.',
        status: 'pending',
        subSteps: [
          { id: 'sub_3_1', type: 'api', systemName: 'Assessor Portal', techType: 'API', description: 'Retrieves Westside itemized repair quote (initial $9,200)' },
          {
            id: 'sub_3_2',
            type: 'horizon',
            systemName: 'Conquer',
            techType: 'Workflow',
            description: 'Flags labor above network rate and marks estimate for price correction / concession ask',
          },
          {
            id: 'sub_3_3',
            type: 'phone',
            systemName: 'Shop Manager',
            techType: 'Phone',
            description:
              'Shop negotiation call — collect: (1) network labor rate for sensor calibration ($110/hr), (2) OEM sensors for cameras, (3) any price concession or estimate correction, (4) final agreed quote total',
            chatLog: [
              {
                sender: 'agent',
                name: 'Agent',
                text:
                  'Hi, this is Conquer calling Westside Auto Body about Bharat Bhavnasi claim AUT-2810-VA. Your estimate is at $9,200. Can we align sensor calibration to our network rate of $110/hour, keep OEM cameras, and offer a concession to bring the total in line with guidelines?',
              },
              {
                sender: 'recipient',
                name: 'Shop Manager',
                text:
                  'Agreed — calibration at $110/hour, OEM sensors stay, and we will concede $450 on the estimate. Revised quote is $8,750 before deductible.',
              },
            ],
          },
        ],
      },
      {
        id: 'step_4',
        timeLabel: 'Day 3',
        signal: 'Final clearance & settlement printout',
        agentMemory:
          'Settlement figures come from the LIVE negotiated claimAmount after the shop call (concession + revised total). Deductible still applies before shop payout.',
        status: 'pending',
        subSteps: [
          { id: 'sub_4_1', type: 'api', systemName: 'Claims Accounting', techType: 'Workflow', description: 'Registers checkout receipt in ledger after shop concession' },
          {
            id: 'sub_4_2',
            type: 'custom',
            systemName: 'Claimant inbox',
            techType: 'Email',
            description: 'Emails settlement confirmation with shop payout breakdown',
            // No hardcoded $ amounts — buildContactBrief fills live negotiated totals.
          },
          {
            id: 'sub_4_3',
            type: 'phone',
            systemName: 'Claimant',
            techType: 'Phone',
            description:
              'Final customer confirmation by phone — confirm payout amount, shop payee, deductible, and that a shop concession was applied',
            chatLog: [
              {
                sender: 'recipient',
                name: 'Bharat',
                text: 'Yes, that works — I got the email. Glad they adjusted the price. No changes needed on my end.',
              },
            ],
          },
          { id: 'sub_4_4', type: 'outcome', systemName: 'Outcome', techType: 'Calendar', description: 'Check drafted for shop. Repair cleared pending approval.' },
        ],
      },
    ],
  },
  'elena_rostova': {
    id: 'claim:1003',
    claimantName: 'Elena Rostova',
    claimType: 'Home Water Damage Claim',
    claimAmount: 24500.00,
    status: 'INTAKE',
    policyNumber: 'HOM-3310-RO',
    description: 'Catastrophic basement flood caused by burst copper pipe. Carpeting, drywall, and valuable personal inventory water-logged.',
    currentStepIndex: 0,
    version: 0,
    timeline: [
      {
        id: 'step_1',
        timeLabel: 'Day 1',
        signal: 'Emergency water extraction & structural drying authorized',
        agentMemory: 'Elena has active homeowners protection. Mold mitigation is a high priority.',
        status: 'active',
        subSteps: [
          { id: 'sub_1_1', type: 'horizon', systemName: 'Conquer', techType: 'Workflow', description: 'Triggers disaster clause verification' },
          {
            id: 'sub_1_2',
            type: 'phone',
            systemName: 'Mitigation Team',
            techType: 'Phone',
            description: 'Coordinates rapid response team dispatch',
            chatLog: [
              { sender: 'agent', name: 'Agent', text: 'Hi, I need emergency water mitigation dispatched to Elena Rostova. Drywall moisture levels are high.' },
              { sender: 'recipient', name: 'Technician', text: 'Acknowledged. We are rolling out a truck with industrial dehumidifiers. ETA 45 minutes.' }
            ]
          }
        ]
      },
      {
        id: 'step_2',
        timeLabel: '+1 hour',
        signal: 'Validate plumbing diagnosis & mitigation status',
        agentMemory: 'Water pipe repair itself is not covered, but water extraction & secondary damage rebuild IS covered.',
        status: 'pending',
        subSteps: [
          { id: 'sub_2_1', type: 'api', systemName: 'Mitigation Portal', techType: 'API', description: 'Verifies installation of moisture fans' },
          {
            id: 'sub_2_2',
            type: 'phone',
            systemName: 'Plumber',
            techType: 'Phone',
            description: 'Validates origin of plumbing leak',
            chatLog: [
              { sender: 'agent', name: 'Agent', text: 'Can you confirm the burst pipe source has been fully clamped and repaired?' },
              { sender: 'recipient', name: 'Plumber', text: 'Yes. Replaced 10 feet of ruptured copper main. Restored system pressure, system is stable.' }
            ]
          }
        ]
      },
      {
        id: 'step_3',
        timeLabel: 'Day 3',
        signal: 'Contents audit & replacement cost review',
        agentMemory: 'Claimant uploaded photo inventory. Applying current Replacement Cost Value (RCV) rates.',
        status: 'pending',
        subSteps: [
          { id: 'sub_3_1', type: 'horizon', systemName: 'Conquer', techType: 'Workflow', description: 'Runs damaged inventory OCR pricing matching' },
          { id: 'sub_3_2', type: 'api', systemName: 'Inventory Ledger', techType: 'API', description: 'Updates approved contents list value' },
          {
            id: 'sub_3_3',
            type: 'sms',
            systemName: 'Claimant',
            techType: 'SMS',
            description: 'Asks for electronics receipts',
            chatLog: [
              { sender: 'agent', name: 'Agent', text: 'Elena, we require original purchase receipts for the damaged projector and audio speakers to waive depreciated value.' },
              { sender: 'recipient', name: 'Elena', text: 'I found the original email invoices from Amazon. Sending them over now!' }
            ]
          }
        ]
      },
      {
        id: 'step_4',
        timeLabel: 'Day 4',
        signal: 'Settlement draft released with disaster waiver',
        agentMemory: 'Deductible waived under disaster declaration. Total settlement is $24,500.',
        status: 'pending',
        subSteps: [
          { id: 'sub_4_1', type: 'horizon', systemName: 'Conquer', techType: 'Workflow', description: 'Constructs final settlement layout' },
          { id: 'sub_4_2', type: 'api', systemName: 'Disbursement Portal', techType: 'Workflow', description: 'Triggers direct-to-bank settlement check' },
          { id: 'sub_4_3', type: 'outcome', systemName: 'Outcome', techType: 'Calendar', description: 'Settlement finalized & direct deposit approved' }
        ]
      }
    ]
  }
};

// API: state-store operations (MongoDB)
app.get('/api/mongo/keys', asyncRoute(async (req, res) => {
  res.json(await store.getKeysInfo());
}));

app.get('/api/mongo/logs', (req, res) => {
  res.json(store.getLogs());
});

app.get('/api/mongo/pubsub', (req, res) => {
  res.json(store.getPubSub());
});

app.get('/api/mongo/stats', asyncRoute(async (req, res) => {
  res.json(await store.getStats());
}));

app.post('/api/mongo/cmd', asyncRoute(async (req, res) => {
  const { command } = req.body;
  if (!command) {
    return res.status(400).json({ error: 'Command string is required' });
  }
  const result = await store.executeCLI(command);
  res.json({ result });
}));

// Get list of available claim templates
app.get('/api/claims/templates', (req, res) => {
  const templates = Object.entries(DEFAULT_CLAIMS).map(([key, claim]) => ({
    key,
    id: claim.id,
    claimantName: claim.claimantName,
    claimType: claim.claimType,
    claimAmount: claim.claimAmount,
    status: claim.status
  }));
  res.json({ templates });
});

// Current claim state, plus what the agent is waiting on and which channels are live.
// While parked on SMS or a live call, also poll the provider — webhooks often never
// reach localhost, and a hangup would otherwise leave the claim wedged.
app.get('/api/claims/active', asyncRoute(async (req, res) => {
  await pollSmsInboxFallback();
  await pollCallCompletionFallback();
  const currentClaim = await store.get('claims:active');
  res.json({
    claim: currentClaim,
    awaiting: await getAwaiting(),
    vendorStatus: getVendorStatus(),
    memory: await memoryStatus(),
  });
}));

// Operator disconnect: end the in-flight workflow (call/SMS wait included) and clear the
// active claim so the UI can leave the interaction without wiping the whole database.
app.post('/api/claims/stop', asyncRoute(async (_req, res) => {
  const result = await stopActiveClaim();
  res.json(result);
}));

// Load a predefined claim and immediately hand it to the agent. Opening a claim is the
// only trigger the agent needs -- it drives the timeline from here until it has to wait
// on a reply or on a human approving the settlement.
app.post('/api/claims/load', asyncRoute(async (req, res) => {
  const { claimKey } = req.body;
  const template = DEFAULT_CLAIMS[claimKey];
  if (!template) {
    return res.status(404).json({ error: 'Claim template not found' });
  }

  // Preserve the previous interaction before overwriting the singleton active claim.
  await archiveActiveSession('replaced', await getAwaiting()).catch(() => {});

  // Deep clone so replaying a template never mutates the in-memory definition.
  const claim: Claim = JSON.parse(JSON.stringify(template));
  claim.version = 0;
  beginSession(claim);
  // Demo recipients always win: every loaded claim contacts DEMO_CLAIMANT_* so a
  // single handset/inbox can drive the live webhook loop end-to-end.
  claim.claimantPhone = process.env.DEMO_CLAIMANT_PHONE || claim.claimantPhone;
  claim.claimantEmail = process.env.DEMO_CLAIMANT_EMAIL || claim.claimantEmail;

  // Fan the claim out into flat projection keys alongside the whole document, so the
  // dashboard shows both the nested `document` and the cheap scalars an operator scans.
  await store.set('claims:active', claim, 'document');
  await store.set('claims:active_id', claim.id, 'string');
  await store.set('claims:status', claim.status, 'string');
  await store.set('claims:amount', String(claim.claimAmount), 'string');
  await store.set('claims:claimant', claim.claimantName, 'string');
  // A previous claim's outstanding contact must not leak into this one.
  await store.del('claims:awaiting').catch(() => {});
  await saveSessionSnapshot(claim, { endReason: 'active', awaiting: null });

  store.log(
    'INFO',
    `Loaded claim template "${claim.claimantName}" into cache (session ${claim.sessionId})`
  );
  await store.publish('claims:pubsub', `CLAIM_LOADED:${claim.id}`);

  const advanced = (await withClaimLock(claim.id, () => advanceClaim(claim))) ?? claim;
  res.json({ claim: advanced, awaiting: await getAwaiting() });
}));

// Past / live interaction sessions (full claim + chatLogs + workingMemory).
app.get('/api/claims/sessions', asyncRoute(async (_req, res) => {
  const sessions = await listSessionSummaries();
  res.json({ sessions });
}));

app.get('/api/claims/sessions/:sessionId', asyncRoute(async (req, res) => {
  const session = await getSession(String(req.params.sessionId));
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ session });
}));

// Resume a saved session into claims:active (archives the current active run first).
app.post('/api/claims/sessions/:sessionId/resume', asyncRoute(async (req, res) => {
  const session = await getSession(String(req.params.sessionId));
  if (!session) return res.status(404).json({ error: 'Session not found' });

  await archiveActiveSession('replaced', await getAwaiting()).catch(() => {});

  const claim: Claim = JSON.parse(JSON.stringify(session.claim));
  // Keep the same sessionId so further progress appends to this archive.
  if (!claim.sessionId) {
    claim.sessionId = session.sessionId;
    claim.sessionStartedAt = session.startedAt;
  }

  await store.set('claims:active', claim, 'document', undefined, true);
  await store.set('claims:active_id', claim.id, 'string', undefined, true);
  await store.set('claims:status', claim.status, 'string', undefined, true);
  await store.set('claims:amount', String(claim.claimAmount), 'string', undefined, true);
  await store.set('claims:claimant', claim.claimantName, 'string', undefined, true);

  if (session.awaiting) {
    await store.set('claims:awaiting', session.awaiting, 'document', undefined, true);
  } else {
    await store.del('claims:awaiting').catch(() => {});
  }

  await saveSessionSnapshot(claim, {
    endReason: 'active',
    awaiting: session.awaiting ?? null,
  });

  store.log('INFO', `Resumed session ${session.sessionId} for claim ${claim.id}`);
  await store.publish('claims:pubsub', `CLAIM_RESUMED:${claim.id}`);

  res.json({
    claim,
    awaiting: session.awaiting ?? (await getAwaiting()),
  });
}));

// Force-advance override (demo / testing only).
//
// The normal path is event-driven: the agent fires an outbound contact and waits for the
// real reply to arrive on a webhook. This endpoint skips that wait -- if the claim is
// parked on a contact it synthesizes a plausible reply and applies it, otherwise it just
// pushes the walk forward. Useful for demos and when a reply is never coming.
app.post('/api/claims/process-step', asyncRoute(async (req, res) => {
  const claim = asClaim(await store.get('claims:active'));
  if (!claim) {
    return res.status(400).json({ error: 'No active claim loaded' });
  }

  if (claim.status === 'RESOLVED' || claim.status === 'CLOSED') {
    return res.json({ claim, finished: true });
  }

  // Settlement is gated on a human; force-advance must not be a way around it.
  if (claim.status === 'AWAITING_APPROVAL') {
    return res.json({ claim, finished: false, awaitingApproval: true });
  }

  const awaiting = await getAwaiting();

  if (awaiting) {
    const step = claim.timeline[awaiting.stepIndex];
    const sub = step?.subSteps.find(s => s.id === awaiting.subStepId);
    if (sub) {
      store.log('COMMAND', `FORCE_ADVANCE: synthesizing a reply for [${sub.systemName}] instead of waiting`);
      await store.publish('claims:pubsub', `AGENT_FORCE_ADVANCE:${sub.id}`);

      const replyText = await synthesizeReply(claim, sub);
      // Recover the raw lookup value by stripping the known prefix rather than splitting
      // on ':' -- a conversation id may legitimately contain colons.
      const prefix = `claims:lookup:${awaiting.channel}:`;
      const lookupValue = awaiting.lookupKey.startsWith(prefix)
        ? awaiting.lookupKey.slice(prefix.length)
        : awaiting.lookupKey;

      const resolved = await resolveAwaitingSubStep({
        channel: awaiting.channel,
        lookupValue,
        replyText,
        // Unique per force-advance so the dedupe set never suppresses a manual override.
        // The SESSION id is load-bearing here: claim ids come from templates and `version`
        // restarts at 0 on every load, so without it a second run of the same template
        // regenerates run 1's event ids, `markEventSeen` reports them as already applied,
        // and every force-advance 409s with "the claim changed underneath us".
        eventId: `force:${claim.sessionId ?? 'nosession'}:${claim.id}:${sub.id}:${claim.version}`,
        // Nobody was actually contacted: this reply was invented (by the model or the canned
        // fallback). It must never render as a real inbound reply.
        replySource: 'synthesized',
      });

      if (resolved) {
        return res.json({
          claim: resolved,
          finished: resolved.status === 'RESOLVED',
          awaitingApproval: resolved.status === 'AWAITING_APPROVAL',
          awaiting: await getAwaiting(),
        });
      }

      // Deliberately do NOT fall through to advancing the claim we read above.
      // resolveAwaitingSubStep returns null both when a guard ignored the event and when a
      // concurrent webhook held the mutex. In the latter case that webhook has already
      // persisted a newer claim, and advancing our stale copy would force-write over it --
      // erasing the applied reply and the contact it dispatched, which wedges the claim
      // unrecoverably (the awaiting key names a sub-step whose status was rolled back).
      // Report the fresh state instead and let the caller retry.
      store.log('ERROR', 'FORCE_ADVANCE could not resolve the awaiting contact - not advancing a stale claim');
      const current = asClaim(await store.get('claims:active'));
      return res.status(409).json({
        error: 'Could not apply the synthesized reply - the claim changed underneath us. Retry.',
        claim: current,
        awaiting: await getAwaiting(),
      });
    }
  }

  // Re-read inside the mutex: the copy above may already be stale.
  const advanced = await withClaimLock(claim.id, async () => {
    const fresh = asClaim(await store.get('claims:active'));
    return fresh ? advanceClaim(fresh) : null;
  });

  if (!advanced) {
    return res.status(409).json({ error: 'Claim is busy - another update is in flight. Retry.' });
  }

  res.json({
    claim: advanced,
    finished: advanced.status === 'RESOLVED',
    awaitingApproval: advanced.status === 'AWAITING_APPROVAL',
    awaiting: await getAwaiting(),
  });
}));

// Human-in-the-loop settlement gate. This is the only path that releases money.
//
// The status gate is evaluated INSIDE the mutex, against a claim re-read inside the mutex.
// Checking a copy read beforehand allowed two concurrent requests to both observe
// AWAITING_APPROVAL and both finalize -- and because the lock has a TTL, a slow
// finalizeClaim (model call plus backoff) could let its lock expire mid-flight and a second
// request legitimately acquire it. One human click, two settlement checks.
app.post('/api/claims/approve-payout', asyncRoute(async (req, res) => {
  const claimId = await store.get('claims:active_id');
  if (!claimId || typeof claimId !== 'string' || claimId === 'null') {
    return res.status(400).json({ error: 'No active claim loaded' });
  }

  const outcome = await withClaimLock(claimId, async (): Promise<
    | { kind: 'ok' | 'already'; claim: Claim }
    | { kind: 'none' }
    | { kind: 'wrongStatus'; status: string }
  > => {
    const claim = asClaim(await store.get('claims:active'));
    if (!claim) return { kind: 'none' };

    // Idempotent: a double-click must not draft a second settlement.
    if (claim.status === 'RESOLVED' || claim.status === 'CLOSED') return { kind: 'already', claim };
    if (claim.status !== 'AWAITING_APPROVAL') return { kind: 'wrongStatus', status: claim.status };

    store.log('INFO', `ADJUSTER_APPROVAL: settlement sign-off received for ${claim.claimantName}`);
    await store.publish('claims:pubsub', `ADJUSTER_APPROVED:${claim.id}`);

    return { kind: 'ok', claim: await finalizeClaim(claim) };
  });

  if (!outcome) {
    return res.status(409).json({ error: 'Claim is busy - another update is in flight. Retry.' });
  }
  if (outcome.kind === 'none') {
    return res.status(400).json({ error: 'No active claim loaded' });
  }
  if (outcome.kind === 'wrongStatus') {
    return res.status(409).json({
      error: 'Claim is not awaiting approval yet - the agent has not finished working it.',
      status: outcome.status,
    });
  }

  res.json({
    claim: outcome.claim,
    finished: true,
    ...(outcome.kind === 'already' ? { alreadyResolved: true } : {}),
  });
}));

// Trigger a completely custom claim generation using the language model
app.post('/api/claims/custom-create', asyncRoute(async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  store.log('INFO', `Asking ${modelName()} to synthesize a custom claim scenario and multi-stage workflow`);
  if (!isLlmConfigured()) {
    return res.status(400).json({
      error: process.env.MOCK_MODE === 'true'
        ? 'Custom claim generation needs the language model, which MOCK_MODE disables. Unset MOCK_MODE to use it.'
        : 'Set OPENAI_API_KEY in your .env file to generate custom claims.',
    });
  }

  try {
    // Strict mode has no optional keys: every property must be required and
    // additionalProperties false. `techType` and `chatLog` were optional under the old
    // schema, so they become explicitly nullable here.
    const chatMessageSchema = strictObject({ sender: str, name: str, text: str });
    const subStepSchema = strictObject({
      id: str,
      type: str,
      systemName: str,
      techType: nullable(str),
      description: str,
      chatLog: nullable(arrayOf(chatMessageSchema)),
    });
    const claimSchema = strictObject({
      id: str,
      claimantName: str,
      claimType: str,
      claimAmount: num,
      status: str,
      policyNumber: str,
      description: str,
      currentStepIndex: int,
      timeline: arrayOf(strictObject({
        id: str,
        timeLabel: str,
        signal: str,
        agentMemory: str,
        status: str,
        subSteps: arrayOf(subStepSchema),
      })),
    });

    const generated = await generateJson<Claim>({
      label: 'custom-claim',
      schemaName: 'insurance_claim_timeline',
      schema: claimSchema,
      prompt: `Generate a fully customized 4-stage insurance claim lifecycle timeline based on this prompt: "${prompt}".
The claimant name, claim type, estimate amount, and incident description should be parsed or creatively imagined from the prompt.
The timeline MUST have exactly 4 stages.
Stage 1: Day 1 (or starting time). 3 or 4 substeps detailing initial signals.
Stage 2: e.g. "+15 minutes" or "Day 2". 3 substeps detailing coordination or tool logs.
Stage 3: e.g. "Day 3". 3 or 4 substeps detailing verification or document liaisons.
Stage 4: Ending time. Finalization.
Substep type must be one of: horizon, api, phone, tool, sms, outcome.
Keep system names literal (e.g. Conquer, Payer portal, EHR, Auto Shop, Claims Adjuster, Scheduling).
Include a brief placeholder chatLog (2 messages) for phone and sms substeps; use null for chatLog on substeps that are not a conversation, and null for techType when it does not apply.
Step ids should be step_1..step_4 and substep ids sub_<step>_<n>. The first step's status is "active", the rest "pending".`,
    });

    if (generated) {
      const customClaim: Claim = generated;
      // Re-initialize status correctly
      customClaim.status = 'INTAKE';
      customClaim.currentStepIndex = 0;
      customClaim.id = `claim:custom_${Date.now()}`;
      customClaim.version = 0;
      customClaim.claimantPhone = customClaim.claimantPhone ?? process.env.DEMO_CLAIMANT_PHONE;
      customClaim.claimantEmail = customClaim.claimantEmail ?? process.env.DEMO_CLAIMANT_EMAIL;

      // Load into MongoDB
      await store.set('claims:active', customClaim, 'document');
      await store.set('claims:active_id', customClaim.id, 'string');
      await store.set('claims:status', 'INTAKE', 'string');
      await store.set('claims:amount', String(customClaim.claimAmount), 'string');
      await store.set('claims:claimant', customClaim.claimantName, 'string');
      await store.del('claims:awaiting').catch(() => {});

      store.log('INFO', `Dynamically compiled and loaded custom claim for "${customClaim.claimantName}"`);
      await store.publish('claims:pubsub', `CUSTOM_CLAIM_COMPILED:${customClaim.id}`);

      // Same as /load: opening the claim is the trigger; hand it straight to the agent.
      const advanced = (await withClaimLock(customClaim.id, () => advanceClaim(customClaim))) ?? customClaim;
      res.json({ claim: advanced, awaiting: await getAwaiting() });
    } else {
      res.status(500).json({ error: 'Empty generation from model' });
    }
  } catch (err: any) {
    console.error('Error generating custom claim:', err);
    res.status(500).json({ error: `Model synthesis failed: ${err.message || err}` });
  }
}));

// Root Vite Middleware integration
async function startServer() {
  // MongoDB holds all claim state, memory and checkpoints, so nothing can serve until it
  // is connected.
  await initDb();
  await initCheckpoints();
  await initMemory();

  // The point of checkpointing: a claim parked on a webhook for days must survive a deploy.
  // Runs before the listener opens so a recovered claim is already live on the first request.
  await recoverOnBoot();

  // Long-horizon SMS only advances when inbound webhooks reach us. Register the
  // Railway (or PUBLIC_WEBHOOK_BASE) receive URL on the Sendblue account at boot so
  // a fresh deploy cannot silently wait forever again.
  const publicBase = (
    process.env.PUBLIC_WEBHOOK_BASE ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
  ).replace(/\/+$/, '');
  if (publicBase) {
    void smsChannel
      .ensureReceiveWebhook(`${publicBase}/webhooks/sendblue/inbound`)
      .then(ok => {
        if (ok) console.log(`[Sendblue] Receive webhook ensured at ${publicBase}/webhooks/sendblue/inbound`);
      })
      .catch(err => console.warn('[Sendblue] ensureReceiveWebhook:', err));
  }

  // `npm run dev` always mounts Vite, even if .env sets NODE_ENV=production
  // (that flag is for Mongo/connection behaviour, not for which UI to serve).
  const useVite =
    process.env.npm_lifecycle_event === 'dev' ||
    process.argv.some(arg => arg.endsWith('server.ts'));

  if (useVite) {
    const vite = await createViteServer({
      // .env sets NODE_ENV=production for Mongo; that would make Vite skip
      // the Tailwind serve transform and ship uncompiled CSS (no utilities).
      mode: 'development',
      server: {
        middlewareMode: true,
        // The stuck :3000 process already owns Vite's default HMR port 24678.
        hmr: {
          port: (Number(process.env.PORT) || 3001) + 21678,
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    // Bind address, not a browse address -- open http://localhost:PORT locally.
    console.log(`Server listening on port ${PORT} -> http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
