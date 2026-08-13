/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  AgentMemoryEntry,
  AgentMemoryStatus,
  AwaitingContact,
  CheckpointSummary,
  Claim,
  DbKeyInfo,
  DbLog,
  DbPubSubMsg,
  DbStats,
} from '../types';
import {
  Terminal,
  Database,
  Activity,
  RefreshCw,
  Key,
  ShieldAlert,
  ArrowRight,
  Brain,
  Hourglass,
  Sparkles,
  GitCommitVertical,
  Undo2,
} from 'lucide-react';

interface MongoDashboardProps {
  keys: DbKeyInfo[];
  logs: DbLog[];
  pubsub: DbPubSubMsg[];
  stats: DbStats | null;
  onRefresh: () => void;
  onExecCommand: (cmd: string) => Promise<string>;
  claim?: Claim | null;
  awaiting?: AwaitingContact | null;
  /** Long-term memory from earlier claims (`agent_memory`). */
  memories?: AgentMemoryEntry[];
  memoryStatus?: AgentMemoryStatus | null;
  /** Transition lineage for the active thread (`checkpoints`). */
  checkpoints?: CheckpointSummary[];
  onRestoreCheckpoint?: (checkpointId: string) => Promise<void>;
}

const money = (amount: number): string => `$${amount.toLocaleString()}`;

const clock = (iso: string): string => {
  const parsed = new Date(iso);
  return isNaN(parsed.getTime()) ? iso : parsed.toLocaleTimeString();
};

/** The structured outcome behind a memory -- the part that changes the next decision. */
const factLine = (facts: AgentMemoryEntry['facts']): string =>
  Object.entries(facts)
    .filter(([, v]) => v !== null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('  ');

const keyValue = (keys: DbKeyInfo[], name: string): string | null => {
  const hit = keys.find(k => k.key === name);
  if (!hit) return null;
  return hit.value;
};

const prettyJson = (raw: string | null): string | null => {
  if (!raw) return null;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
};

export const MongoDashboard: React.FC<MongoDashboardProps> = ({
  keys,
  logs,
  pubsub,
  stats,
  onRefresh,
  onExecCommand,
  claim = null,
  awaiting = null,
  memories = [],
  memoryStatus = null,
  checkpoints = [],
  onRestoreCheckpoint,
}) => {
  const [restoring, setRestoring] = useState<string | null>(null);
  const [cliInput, setCliInput] = useState('');
  const [cliHistory, setCliHistory] = useState<{ cmd: string; response: string }[]>([
    { cmd: 'INFO', response: '# Conquer MongoDB\nstatus:ONLINE\nview:memory+state' },
  ]);
  const [activeTab, setActiveTab] = useState<'events' | 'keys' | 'cli'>('events');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const feedEndRef = useRef<HTMLDivElement>(null);
  const cliTerminalEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cliTerminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [cliHistory]);

  useEffect(() => {
    if (activeTab === 'events') {
      feedEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs.length, pubsub.length, activeTab]);

  const workingMemory =
    claim?.workingMemory?.trim() ||
    keyValue(keys, 'claims:working_memory')?.replace(/^"|"$/g, '') ||
    null;

  const awaitingRaw = keyValue(keys, 'claims:awaiting');
  const awaitingPretty = prettyJson(awaitingRaw);

  const activeStep = claim?.timeline?.[claim.currentStepIndex];

  const handleCommandSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const command = cliInput.trim();
    if (!command) return;
    const res = await onExecCommand(command);
    setCliHistory(prev => [...prev, { cmd: command, response: res }]);
    setCliInput('');
    onRefresh();
  };

  const executeHelper = async (cmdStr: string) => {
    const res = await onExecCommand(cmdStr);
    setCliHistory(prev => [...prev, { cmd: cmdStr, response: res }]);
    onRefresh();
  };

  const getBadgeColor = (type: string) => {
    switch (type) {
      case 'string':
        return 'bg-mdb-forest/30 text-mdb-leaf border-mdb-leaf/20';
      case 'array':
        return 'bg-mdb-spruce text-mdb-mint border-mdb-mint/20';
      case 'document':
        return 'bg-mdb-leaf/15 text-mdb-leaf border-mdb-leaf/30';
      case 'set':
        return 'bg-mdb-forest/40 text-mdb-mint border-mdb-forest';
      default:
        return 'bg-mdb-elevated text-mdb-fog border-mdb-border';
    }
  };

  const contextKeys = keys.filter(k =>
    k.key.startsWith('claims:') || k.key.startsWith('claims:lookup:')
  );

  return (
    <div
      className="bg-mdb-black border border-mdb-border text-mdb-fog rounded-2xl p-6 flex flex-col gap-5 shadow-xl"
      id="mongo-dashboard-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-mdb-border pb-5">
        <div className="flex items-center gap-2.5">
          <div className="p-2 bg-mdb-leaf/10 border border-mdb-leaf/30 text-mdb-leaf rounded-xl">
            <Database className="size-5" />
          </div>
          <div>
            <h3 className="font-bold text-base tracking-tight flex items-center gap-2">
              MongoDB — Memory &amp; State
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                LIVE
              </span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Claim memory, awaiting contacts, pub/sub, and command logs in one view
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-6 text-xs font-mono">
            <div className="hidden sm:block">
              <span className="text-slate-500 block text-[9px] uppercase tracking-wider">USED MEMORY</span>
              <span className="font-bold text-slate-200">
                {stats ? `${(stats.usedMemory / 1024).toFixed(2)} KB` : '...'}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block text-[9px] uppercase tracking-wider">TOTAL KEYS</span>
              <span className="font-bold text-slate-200">{stats ? stats.totalKeys : '...'}</span>
            </div>
            <div>
              <span className="text-slate-500 block text-[9px] uppercase tracking-wider">EVENTS</span>
              <span className="font-bold text-slate-200">{logs.length + pubsub.length}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="p-2 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg border border-slate-800 transition"
            title="Refresh database view"
            aria-label="Refresh MongoDB view"
          >
            <RefreshCw className="size-4" />
          </button>
        </div>
      </div>

      {/* Always-visible claim / store context */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3.5 flex flex-col gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
            <Activity className="size-3.5 text-sky-400" />
            Active claim
          </span>
          {claim ? (
            <div className="text-[12px] font-mono text-slate-200 space-y-1">
              <div>
                <span className="text-slate-500">id </span>
                {claim.id}
              </div>
              <div>
                <span className="text-slate-500">claimant </span>
                {claim.claimantName}
              </div>
              <div>
                <span className="text-slate-500">status </span>
                {claim.status}
              </div>
              <div>
                <span className="text-slate-500">step </span>
                {activeStep?.timeLabel ?? '—'} · {activeStep?.signal ?? '—'}
              </div>
              <div>
                <span className="text-slate-500">amount </span>
                ${claim.claimAmount.toLocaleString()}
                {claim.shopConcession != null && claim.shopConcession > 0
                  ? ` (−$${claim.shopConcession.toLocaleString()} shop)`
                  : ''}
              </div>
            </div>
          ) : (
            <p className="text-[12px] text-slate-500">No active claim loaded.</p>
          )}
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3.5 flex flex-col gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
            <Brain className="size-3.5 text-mdb-leaf" />
            Working memory
            <span className="text-slate-600 normal-case font-mono">claims:working_memory</span>
          </span>
          <pre className="text-[11px] font-mono text-slate-300 whitespace-pre-wrap max-h-28 overflow-y-auto leading-relaxed">
            {workingMemory || '(empty — load a claim / complete a contact)'}
          </pre>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3.5 flex flex-col gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
            <Hourglass className="size-3.5 text-amber-400" />
            Awaiting contact
            <span className="text-slate-600 normal-case font-mono">claims:awaiting</span>
          </span>
          {awaiting ? (
            <div className="text-[12px] font-mono text-amber-100/90 space-y-1">
              <div>
                <span className="text-slate-500">channel </span>
                {awaiting.channel}
              </div>
              <div>
                <span className="text-slate-500">subStep </span>
                {awaiting.subStepId}
              </div>
              <div className="truncate">
                <span className="text-slate-500">lookup </span>
                {awaiting.lookupKey}
              </div>
              <div>
                <span className="text-slate-500">sentAt </span>
                {awaiting.sentAt}
              </div>
            </div>
          ) : awaitingPretty ? (
            <pre className="text-[11px] font-mono text-slate-300 whitespace-pre-wrap max-h-28 overflow-y-auto">
              {awaitingPretty}
            </pre>
          ) : (
            <p className="text-[12px] text-slate-500">Nothing waiting on a reply.</p>
          )}
        </div>
      </div>

      {/*
        The two collections that make this agent not cold-start. Left: what earlier claims
        taught it. Right: where this claim has been, and the button that rewinds it there.
      */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3.5 flex flex-col gap-2 min-h-[180px]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
              <Sparkles className="size-3.5 text-mdb-leaf" />
              Agent memory
              <span className="text-slate-600 normal-case font-mono">agent_memory</span>
            </span>
            {memoryStatus && (
              <span
                className={`px-2 py-0.5 rounded-full text-[9px] font-bold border ${
                  memoryStatus.mode === 'vector'
                    ? 'bg-mdb-leaf/15 text-mdb-leaf border-mdb-leaf/30'
                    : 'bg-slate-700/40 text-slate-300 border-slate-600/40'
                }`}
                title={
                  memoryStatus.mode === 'vector'
                    ? 'Recall served by Atlas Vector Search ($vectorSearch)'
                    : 'Recall served by keyword scoring — needs Atlas plus an embedding model for vector recall'
                }
              >
                {memoryStatus.mode === 'vector' ? 'VECTOR' : 'KEYWORD'} · {memoryStatus.total}
              </span>
            )}
          </div>
          {memories.length === 0 ? (
            <p className="text-[12px] text-slate-500">
              Nothing learned yet. Memories are written from real outcomes — a negotiated total, a
              genuine inbound reply, a settlement — and recalled on the next claim.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-40 overflow-y-auto">
              {memories.map(m => (
                <div
                  key={m.id}
                  className="rounded-lg border border-slate-800 bg-slate-900/50 px-2.5 py-1.5"
                >
                  <div className="flex items-center gap-2 text-[10px] font-mono">
                    <span className="px-1.5 py-0.5 rounded bg-mdb-leaf/10 text-mdb-leaf border border-mdb-leaf/20">
                      {m.kind}
                    </span>
                    <span className="text-slate-300 truncate">{m.counterparty}</span>
                    <span className="text-slate-600 ml-auto shrink-0">{clock(m.createdAt)}</span>
                  </div>
                  <p className="text-[11px] text-slate-200 mt-1 leading-snug">{m.text}</p>
                  {factLine(m.facts) && (
                    <p className="text-[10px] font-mono text-emerald-400/80 mt-0.5">{factLine(m.facts)}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3.5 flex flex-col gap-2 min-h-[180px]">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
            <GitCommitVertical className="size-3.5 text-amber-400" />
            Checkpoints
            <span className="text-slate-600 normal-case font-mono">
              checkpoints{claim ? ` · thread ${claim.id}` : ''}
            </span>
          </span>
          {checkpoints.length === 0 ? (
            <p className="text-[12px] text-slate-500">
              No transitions recorded. Every advance, dispatch and reply appends one, so a restart
              resumes the claim instead of losing it.
            </p>
          ) : (
            <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
              {checkpoints.map(cp => (
                <div
                  key={cp.checkpointId}
                  className="flex items-center gap-2 text-[11px] font-mono rounded px-2 py-1 hover:bg-slate-900/70 border border-transparent hover:border-slate-800"
                >
                  <span className="text-slate-600 shrink-0 tabular-nums">{clock(cp.ts)}</span>
                  <span className="text-amber-300 shrink-0">{cp.reason}</span>
                  <span className="text-slate-400 shrink-0">
                    step {cp.stepIndex} · v{cp.version}
                  </span>
                  <span className="text-slate-300 truncate">{money(cp.claimAmount)}</span>
                  {onRestoreCheckpoint && (
                    <button
                      type="button"
                      disabled={restoring !== null}
                      onClick={async () => {
                        setRestoring(cp.checkpointId);
                        try {
                          await onRestoreCheckpoint(cp.checkpointId);
                        } finally {
                          setRestoring(null);
                        }
                      }}
                      className="ml-auto shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-700 text-slate-400 hover:text-white hover:border-slate-500 disabled:opacity-40 transition"
                      title="Rewind the live claim to this transition (restores state only — nothing is re-sent)"
                    >
                      <Undo2 className="size-2.5" />
                      {restoring === cp.checkpointId ? '…' : 'restore'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-stretch">
        <div className="flex flex-col border border-slate-800 rounded-xl overflow-hidden bg-slate-950/50 min-h-[420px]">
          <div className="flex border-b border-slate-800 bg-slate-950 p-1">
            <button
              type="button"
              onClick={() => setActiveTab('events')}
              className={`flex-1 py-2 px-3 text-xs font-bold rounded-md flex items-center justify-center gap-1.5 transition ${
                activeTab === 'events'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Terminal className="size-3.5" />
              Events + Logs ({logs.length + pubsub.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('keys')}
              className={`flex-1 py-2 px-3 text-xs font-bold rounded-md flex items-center justify-center gap-1.5 transition ${
                activeTab === 'keys'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Key className="size-3.5" />
              Keys ({keys.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('cli')}
              className={`flex-1 py-2 px-3 text-xs font-bold rounded-md flex items-center justify-center gap-1.5 transition xl:hidden ${
                activeTab === 'cli'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Terminal className="size-3.5" />
              CLI
            </button>
          </div>

          <div className="p-3 flex-1 h-[380px] overflow-y-auto">
            {activeTab === 'events' && (
              <div className="flex flex-col gap-0.5 font-mono text-[11px]">
                {logs.length === 0 && pubsub.length === 0 ? (
                  <div className="text-center py-12 text-slate-500 text-xs">
                    No events yet — load a claim to generate database activity.
                  </div>
                ) : (
                  <>
                    {logs.map((log, idx) => (
                      <div
                        key={`L-${idx}`}
                        className="flex gap-2 leading-relaxed px-1.5 py-1 rounded hover:bg-slate-900/80 border border-transparent hover:border-slate-800"
                      >
                        <span className="text-slate-500 shrink-0 tabular-nums">[{log.timestamp}]</span>
                        <span
                          className={`font-bold shrink-0 w-[4.5rem] ${
                            log.level === 'ERROR'
                              ? 'text-red-400'
                              : log.level === 'COMMAND'
                                ? 'text-amber-400'
                                : log.level === 'PUB_SUB'
                                  ? 'text-violet-400'
                                  : 'text-sky-400'
                          }`}
                        >
                          {log.level}
                        </span>
                        <span className="text-slate-200 break-words min-w-0">{log.msg}</span>
                      </div>
                    ))}
                    {pubsub.length > 0 && (
                      <>
                        <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mt-3 mb-1 px-1.5">
                          Pub/Sub events
                        </div>
                        {pubsub.map((msg, idx) => (
                          <div
                            key={`P-${idx}`}
                            className="flex gap-2 leading-relaxed px-1.5 py-1 rounded hover:bg-slate-900/80 border border-transparent hover:border-slate-800"
                          >
                            <span className="text-slate-500 shrink-0 tabular-nums">[{msg.timestamp}]</span>
                            <span className="text-violet-400 font-bold shrink-0">PUB_SUB</span>
                            <span className="text-rose-400/90 shrink-0">{msg.channel}</span>
                            <span className="text-slate-200 break-words min-w-0">{msg.message}</span>
                          </div>
                        ))}
                      </>
                    )}
                    <div ref={feedEndRef} />
                  </>
                )}
              </div>
            )}

            {activeTab === 'keys' && (
              <div className="flex flex-col gap-2">
                {keys.length === 0 ? (
                  <div className="text-center py-12 text-slate-500 text-xs">
                    No documents in the kv collection. Load a claimant to populate MongoDB.
                  </div>
                ) : (
                  <>
                    {contextKeys.length > 0 && (
                      <p className="text-[10px] uppercase tracking-wider text-slate-500 font-bold px-0.5">
                        Claim context keys
                      </p>
                    )}
                    {keys.map(k => {
                      const isExpanded = expandedKey === k.key;
                      const isContext =
                        k.key.startsWith('claims:') || k.key.includes('working_memory');
                      return (
                        <div
                          key={k.key}
                          className={`border rounded-lg transition duration-200 bg-slate-900/60 p-3 flex flex-col gap-2 ${
                            isExpanded
                              ? 'border-slate-700 bg-slate-900'
                              : isContext
                                ? 'border-sky-900/60'
                                : 'border-slate-800 hover:border-slate-700'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                className={`px-2 py-0.5 text-[9px] font-bold uppercase rounded border ${getBadgeColor(k.type)}`}
                              >
                                {k.type}
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  setCliInput(`GET "${k.key}"`);
                                  setExpandedKey(isExpanded ? null : k.key);
                                }}
                                className="font-mono text-xs font-semibold text-slate-200 hover:text-mdb-leaf cursor-pointer truncate text-left"
                              >
                                {k.key}
                              </button>
                            </div>
                            <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400 shrink-0">
                              {k.locked && (
                                <span className="flex items-center gap-0.5 bg-rose-500/15 text-rose-400 px-1.5 py-0.5 rounded border border-rose-500/20">
                                  <ShieldAlert className="size-2.5" />
                                  LOCK
                                </span>
                              )}
                              <span>{k.ttl !== null ? `TTL ${k.ttl}s` : 'PERSIST'}</span>
                            </div>
                          </div>
                          <button
                            type="button"
                            className={`mt-0.5 font-mono text-[11px] bg-slate-950 p-2.5 rounded-md border border-slate-900 text-slate-300 overflow-x-auto whitespace-pre-wrap text-left w-full ${
                              isExpanded
                                ? 'max-h-64 overflow-y-auto'
                                : 'line-clamp-2 opacity-70 text-[10px]'
                            }`}
                            onClick={() => setExpandedKey(isExpanded ? null : k.key)}
                          >
                            {k.key === 'claims:active' && !isExpanded
                              ? 'claims:active → { claimant, status, timeline, workingMemory, … }'
                              : k.key === 'claims:active' && isExpanded
                                ? prettyJson(k.value) ?? k.value
                                : k.value}
                          </button>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            )}

            {activeTab === 'cli' && (
              <div className="xl:hidden font-mono text-xs text-slate-400 p-2">
                Use the CLI panel on wide screens, or open shortcuts below.
              </div>
            )}
          </div>
        </div>

        {/* CLI */}
        <div className="flex flex-col border border-slate-800 rounded-xl overflow-hidden bg-slate-950 min-h-[420px]">
          <div className="bg-slate-950 p-3 border-b border-slate-800 flex items-center justify-between">
            <span className="text-xs font-bold font-mono tracking-wide text-slate-200 flex items-center gap-1.5">
              <Terminal className="size-4 text-emerald-500" />
              MongoDB CLI
            </span>
            <span className="text-[10px] font-mono text-emerald-500/80 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded">
              ● ONLINE
            </span>
          </div>

          <div className="p-4 flex-1 h-[270px] overflow-y-auto font-mono text-xs flex flex-col gap-3 bg-slate-950 select-text">
            {cliHistory.map((item, idx) => (
              <div key={idx} className="flex flex-col gap-1 border-b border-slate-900/60 pb-2">
                <div className="flex items-center gap-1 text-slate-400">
                  <span className="text-emerald-500">mongo&gt;</span>
                  <span className="font-bold text-slate-200">{item.cmd}</span>
                </div>
                <pre className="text-emerald-400 whitespace-pre-wrap pl-4 leading-normal bg-slate-900/40 p-2 rounded border border-slate-900 font-mono">
                  {item.response}
                </pre>
              </div>
            ))}
            <div ref={cliTerminalEndRef} />
          </div>

          <div className="p-3 border-t border-slate-900 bg-slate-900/30 flex flex-wrap gap-1.5 items-center">
            <span className="text-[10px] font-bold text-slate-500 mr-1.5 uppercase font-mono">
              Context:
            </span>
            {[
              'GET claims:working_memory',
              'GET claims:awaiting',
              'GET claims:active',
              'GET claims:status',
              'KEYS claims:*',
              'INFO',
            ].map(cmd => (
              <button
                key={cmd}
                type="button"
                onClick={() => executeHelper(cmd)}
                className="px-2 py-1 text-[10px] font-mono rounded bg-slate-800 border border-slate-800 text-slate-300 hover:text-white hover:bg-slate-700 transition"
              >
                {cmd.replace('GET ', '').replace('KEYS ', '')}
              </button>
            ))}
          </div>

          <form
            onSubmit={handleCommandSubmit}
            className="border-t border-slate-800 flex items-center bg-slate-950 p-2"
          >
            <span className="text-emerald-500 font-mono text-xs px-2 shrink-0">mongo&gt;</span>
            <input
              type="text"
              value={cliInput}
              onChange={e => setCliInput(e.target.value)}
              placeholder='GET claims:working_memory'
              className="flex-1 bg-transparent border-0 outline-none text-xs text-slate-100 font-mono focus:ring-0 p-1"
              aria-label="MongoDB CLI input"
            />
            <button
              type="submit"
              className="p-1.5 text-emerald-500 hover:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 hover:border-emerald-500/40 rounded-lg transition"
              aria-label="Run MongoDB command"
            >
              <ArrowRight className="size-4" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
