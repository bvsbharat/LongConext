/**
 * Create (or reuse) a Conquer outbound claims voice agent in ElevenLabs,
 * list phone numbers, and print the env values to set.
 *
 * Usage: node scripts/setup-elevenlabs-agent.mjs
 * Requires ELEVENLABS_API_KEY in the environment or .env
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

const loadDotEnv = () => {
  const path = resolve(process.cwd(), '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const i = trimmed.indexOf('=');
    const k = trimmed.slice(0, i);
    let v = trimmed.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env) || process.env[k] === '') process.env[k] = v;
  }
};

loadDotEnv();

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) {
  console.error('ELEVENLABS_API_KEY is required');
  process.exit(1);
}

const el = new ElevenLabsClient({ apiKey });
const AGENT_NAME = 'Conquer Claims Outbound';

const placeholders = {
  claim_id: 'claim:0000',
  claimant_name: 'Policyholder',
  claim_type: 'claim',
  claim_amount: '$0.00',
  policy_number: 'POLICY',
  claim_description: 'claim details',
  claim_status: 'PROCESSING',
  step_signal: 'current step',
  agent_memory: '(none)',
  recipient_name: 'Recipient',
  purpose: 'confirm claim details',
};

const prompt = `You are a professional insurance claims assistant calling on behalf of Conquer Claims.
You are making an outbound phone call about an active claim. Keep answers short (1-2 sentences).
Be warm, clear, and efficient. Do not promise payment or settlement — confirm facts and next steps only.

You ALWAYS know these facts for this call (filled in at dial time — never say the curly-brace names out loud):
- Claim ID: {{claim_id}}
- Policyholder / claimant: {{claimant_name}}
- Claim type: {{claim_type}}
- Amount: {{claim_amount}}
- Policy number: {{policy_number}}
- Description: {{claim_description}}
- Status: {{claim_status}}
- Current step: {{step_signal}}
- Memory: {{agent_memory}}
- Who you are speaking with: {{recipient_name}}
- Why you are calling: {{purpose}}

Tasks:
1. Introduce yourself as Conquer claims and name {{claimant_name}} and claim {{claim_id}} early.
2. State {{purpose}} clearly; use {{claim_type}}, {{policy_number}}, and {{claim_amount}} when relevant.
3. Confirm you reached the right person ({{recipient_name}}) when needed.
4. Gather only what {{purpose}} requires.
5. If they are busy, offer a short callback and end politely.
6. When done, summarize what you learned in one sentence and end the call.

Guidelines:
- Never invent coverage, approvals, or dollar amounts beyond {{claim_amount}}.
- If a variable is still a placeholder like "Policyholder", ask a clarifying question instead of guessing.
- Stay on a phone call: short turns, no long monologues.`;

const firstMessage =
  'Hi, this is Conquer calling about claim {{claim_id}} for {{claimant_name}}. Do you have a quick moment?';

const main = async () => {
  const listed = await el.conversationalAi.agents.list();
  const agents = listed?.agents ?? listed?.items ?? (Array.isArray(listed) ? listed : []);
  console.log(`Found ${agents.length} existing agent(s).`);

  let agent = agents.find((a) => (a.name ?? a.agentName) === AGENT_NAME);
  if (agent) {
    console.log(`Reusing existing agent: ${AGENT_NAME}`);
  } else {
    console.log(`Creating agent: ${AGENT_NAME}`);
    agent = await el.conversationalAi.agents.create({
      name: AGENT_NAME,
      tags: ['conquer', 'outbound', 'claims'],
      conversationConfig: {
        tts: {
          // Eric — available in this workspace (docs sample voice ids often 404).
          voiceId: 'cjVigY5qzO86Huf0OWal',
          modelId: 'eleven_flash_v2',
        },
        agent: {
          firstMessage,
          prompt: { prompt },
          dynamicVariables: { dynamicVariablePlaceholders: placeholders },
        },
      },
      platformSettings: {
        overrides: {
          conversationConfigOverride: {
            agent: {
              firstMessage: true,
              language: true,
              prompt: { prompt: true },
            },
          },
        },
      },
    });
  }

  const agentId = agent.agentId ?? agent.agent_id ?? agent.id;
  console.log(`ELEVENLABS_AGENT_ID=${agentId}`);

  // Always refresh placeholders + allow client overrides (SDK create can omit these).
  const patch = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
    method: 'PATCH',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversation_config: {
        agent: {
          first_message: firstMessage,
          prompt: { prompt },
          dynamic_variables: { dynamic_variable_placeholders: placeholders },
        },
      },
      platform_settings: {
        overrides: {
          conversation_config_override: {
            agent: {
              first_message: true,
              language: true,
              prompt: { prompt: true },
            },
          },
        },
      },
    }),
  });
  console.log(`Agent config patch: ${patch.status}`);

  let phones = [];
  try {
    const phoneRes = await el.conversationalAi.phoneNumbers.list();
    phones = Array.isArray(phoneRes)
      ? phoneRes
      : phoneRes?.phoneNumbers ?? phoneRes?.phone_numbers ?? phoneRes?.items ?? [];
  } catch (err) {
    console.warn('Could not list phone numbers:', err?.message ?? err);
  }

  console.log(`Found ${phones.length} phone number(s) in workspace.`);
  for (const p of phones) {
    const id = p.phoneNumberId ?? p.phone_number_id ?? p.id;
    const num = p.phoneNumber ?? p.phone_number ?? p.number;
    console.log(`  ${num}  id=${id}`);
  }

  const phoneId =
    process.env.ELEVENLABS_PHONE_NUMBER_ID ||
    phones[0]?.phoneNumberId ||
    phones[0]?.phone_number_id ||
    phones[0]?.id;

  if (phoneId) {
    console.log(`ELEVENLABS_PHONE_NUMBER_ID=${phoneId}`);
  } else {
    console.log(
      'No phone number found. Import a Twilio number in the ElevenLabs dashboard:\n' +
        '  https://elevenlabs.io/app/agents → Phone Numbers\n' +
        'Then set ELEVENLABS_PHONE_NUMBER_ID to that id.'
    );
  }

  console.log('\nWebhook targets for Conquer on Railway:');
  console.log('  https://web-production-96d85.up.railway.app/webhooks/elevenlabs/call-started');
  console.log('  https://web-production-96d85.up.railway.app/webhooks/elevenlabs/transcript');
  console.log('  https://web-production-96d85.up.railway.app/webhooks/elevenlabs/callback');
  console.log(
    '\nIn ElevenLabs → Agents → your agent → Webhooks, point post-call / transcript\n' +
      'to the callback/transcript URLs above, and copy the signing secret into\n' +
      'ELEVENLABS_WEBHOOK_SECRET.'
  );
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
