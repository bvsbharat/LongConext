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
  ClaimSessionSummary,
  ClaimTemplateInfo,
  DbKeyInfo,
  DbLog,
  DbPubSubMsg,
  DbStats,
  VendorStatus,
} from './types';
import { ClaimTimeline } from './components/ClaimTimeline';
import { ClaimList } from './components/ClaimList';
import { MongoDashboard } from './components/MongoDashboard';
import { BottomDock, type LayoutWidth } from './components/BottomDock';
import { MongoLeaf } from './components/MongoLeaf';
import {
  Database,
  ArrowRight,
  Activity,
  History,
} from 'lucide-react';

const LAYOUT_WIDTH_KEY = 'conquer.layoutWidth';

const LAYOUT_WIDTH_OPTIONS: {
  id: LayoutWidth;
  mainClass: string;
  pagePad: string;
}[] = [
  {
    id: 'comfortable',
    mainClass: 'max-w-[1428px]',
    pagePad: 'px-4 sm:px-6 md:px-8 lg:px-10',
  },
  {
    id: 'wide',
    mainClass: 'max-w-[1870px]',
    pagePad: 'px-3 sm:px-4 md:px-6 lg:px-8',
  },
  {
    id: 'stretch',
    mainClass: 'max-w-none',
    pagePad: 'px-3 sm:px-4 md:px-5',
  },
];

const readLayoutWidth = (): LayoutWidth => {
  try {
    const stored = localStorage.getItem(LAYOUT_WIDTH_KEY);
    if (stored === 'comfortable' || stored === 'wide' || stored === 'stretch') return stored;
  } catch {
    /* ignore */
  }
  return 'wide';
};

const levelColor = (level: string) => {
  if (level === 'ERROR') return 'text-red-400';
  if (level === 'PUB_SUB') return 'text-violet-400';
  if (level === 'COMMAND') return 'text-amber-300';
  if (level === 'INFO') return 'text-[#00ED64]';
  return 'text-zinc-400';
};

export default function App() {
  const [claim, setClaim] = useState<Claim | null>(null);
  const [templates, setTemplates] = useState<ClaimTemplateInfo[]>([]);
  const [sessions, setSessions] = useState<ClaimSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  /** Full-page switch: claims home vs dedicated MongoDB memory/state page. */
  const [page, setPage] = useState<'home' | 'mongo'>(() =>
    typeof window !== 'undefined' && window.location.hash === '#/mongo' ? 'mongo' : 'home'
  );
  const [layoutWidth, setLayoutWidth] = useState<LayoutWidth>(() => readLayoutWidth());
  const layout =
    LAYOUT_WIDTH_OPTIONS.find(o => o.id === layoutWidth) ?? LAYOUT_WIDTH_OPTIONS[1];

  const handleLayoutWidth = (next: LayoutWidth) => {
    setLayoutWidth(next);
    try {
      localStorage.setItem(LAYOUT_WIDTH_KEY, next);
    } catch {
      /* ignore */
    }
  };

  const goHome = () => {
    setPage('home');
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
  };
  const goMongo = () => {
    setPage('mongo');
    window.location.hash = '#/mongo';
  };

  // Long-horizon agent state
  const [awaiting, setAwaiting] = useState<AwaitingContact | null>(null);
  const [vendorStatus, setVendorStatus] = useState<VendorStatus | null>(null);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  // MongoDB state-store view
  const [dbKeys, setDbKeys] = useState<DbKeyInfo[]>([]);
  const [dbLogs, setDbLogs] = useState<DbLog[]>([]);
  const [dbPubsub, setDbPubsub] = useState<DbPubSubMsg[]>([]);
  const [dbStats, setDbStats] = useState<DbStats | null>(null);

  // Agent memory + checkpoints: what earlier claims taught the agent, and where this one
  // has been. Polled with the rest of the store view.
  const [memories, setMemories] = useState<AgentMemoryEntry[]>([]);
  const [memoryStatus, setMemoryStatus] = useState<AgentMemoryStatus | null>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]);

  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  const fetchDbData = async () => {
    try {
      const [keysRes, logsRes, pubsubRes, statsRes, activeClaimRes, memoryRes, checkpointRes] =
        await Promise.all([
          fetch('/api/mongo/keys'),
          fetch('/api/mongo/logs'),
          fetch('/api/mongo/pubsub'),
          fetch('/api/mongo/stats'),
          fetch('/api/claims/active'),
          fetch('/api/agent/memory?limit=12'),
          fetch('/api/agent/checkpoints?limit=12'),
        ]);

      if (keysRes.ok) setDbKeys(await keysRes.json());
      if (logsRes.ok) setDbLogs(await logsRes.json());
      if (pubsubRes.ok) setDbPubsub(await pubsubRes.json());
      if (statsRes.ok) setDbStats(await statsRes.json());
      if (memoryRes.ok) {
        const data = await memoryRes.json();
        setMemories(Array.isArray(data.memories) ? data.memories : []);
        setMemoryStatus(data.status ?? null);
      }
      if (checkpointRes.ok) {
        const data = await checkpointRes.json();
        setCheckpoints(Array.isArray(data.checkpoints) ? data.checkpoints : []);
      }
      
      if (activeClaimRes.ok) {
        const data = await activeClaimRes.json();
        // Hydrate from MongoDB on refresh and keep the open claim in sync with the server.
        if (data.vendorStatus) setVendorStatus(data.vendorStatus);
        if (data.claim) {
          setClaim(data.claim);
          setAwaiting(data.awaiting ?? null);
        } else {
          setClaim(null);
          setAwaiting(null);
        }
      }
    } catch (err) {
      console.error('Error polling:', err);
    }
  };

  // Mutating endpoints return the claim's post-advance `awaiting` alongside it, so the
  // waiting banner appears immediately instead of after the next 2.5s poll. A response
  // that omits the field is left to the poll rather than clearing a live wait.
  const applyAwaiting = (data: { awaiting?: AwaitingContact | null }) => {
    if ('awaiting' in data) setAwaiting(data.awaiting ?? null);
  };

  const loadTemplates = async () => {
    try {
      const res = await fetch('/api/claims/templates');
      if (res.ok) {
        const data = await res.json();
        setTemplates(data.templates);
      }
    } catch (err) {
      console.error('Error loading templates:', err);
    }
  };

  const loadSessions = async () => {
    try {
      const res = await fetch('/api/claims/sessions');
      if (res.ok) {
        const data = await res.json();
        setSessions(Array.isArray(data.sessions) ? data.sessions : []);
      }
    } catch (err) {
      console.error('Error loading sessions:', err);
    }
  };

  const resumeSession = async (sessionId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/claims/sessions/${encodeURIComponent(sessionId)}/resume`, {
        method: 'POST',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to resume session');
      }
      const data = await res.json();
      setClaim(data.claim);
      applyAwaiting(data);
      await loadSessions();
    } catch (err) {
      console.error('Error resuming session:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadClaim = async (claimKey: string) => {
    setLoading(true);
    setAwaiting(null);
    setApproveError(null);
    try {
      const res = await fetch('/api/claims/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimKey })
      });
      if (res.ok) {
        const data = await res.json();
        setClaim(data.claim);
        applyAwaiting(data);
        fetchDbData();
      }
    } catch (err) {
      console.error('Error loading claim template:', err);
    } finally {
      setLoading(false);
    }
  };

  const runAgentStep = async () => {
    if (!claim) return;
    setLoading(true);
    try {
      const res = await fetch('/api/claims/process-step', {
        method: 'POST'
      });
      if (res.ok) {
        const data = await res.json();
        setClaim(data.claim);
        applyAwaiting(data);
        fetchDbData();
      }
    } finally {
      setLoading(false);
    }
  };

  // Human-in-the-loop gate: only valid while the claim sits in AWAITING_APPROVAL
  const approvePayout = async () => {
    if (!claim) return;
    setApproving(true);
    setApproveError(null);
    try {
      const res = await fetch('/api/claims/approve-payout', {
        method: 'POST'
      });
      if (!res.ok) {
        let msg = `Approval rejected by server (HTTP ${res.status}).`;
        try {
          const body = await res.json();
          if (body && body.error) msg = String(body.error);
        } catch {
          // non-JSON error body; keep the status-based message
        }
        setApproveError(msg);
        return;
      }
      const data = await res.json();
      setClaim(data.claim);
      setAwaiting(null);
      fetchDbData();
    } catch (err) {
      setApproveError('Could not reach the server — the settlement was not released.');
    } finally {
      setApproving(false);
    }
  };

  const handleReset = async () => {
    try {
      await fetch('/api/mongo/cmd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'FLUSHALL' })
      });
      setClaim(null); // Go back to list
      setAwaiting(null);
      setApproveError(null);
      loadTemplates();
    } catch (err) {
      console.error('Error clearing database:', err);
    }
  };

  /** End the active claim + outstanding contact without wiping the database. */
  const handleStopWorkflow = async () => {
    if (!claim) return;
    const ok = window.confirm(
      'End this workflow? Any in-progress call or SMS wait will be disconnected from Conquer, and you will return to the claim list.'
    );
    if (!ok) return;
    setLoading(true);
    try {
      const res = await fetch('/api/claims/stop', { method: 'POST' });
      if (!res.ok) {
        console.error('Stop workflow failed', res.status);
        return;
      }
      setClaim(null);
      setAwaiting(null);
      setApproveError(null);
      loadTemplates();
      loadSessions();
      fetchDbData();
    } catch (err) {
      console.error('Error stopping workflow:', err);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Rewind the live claim to an earlier transition. Restores state only -- the server
   * re-sends nothing -- so this is safe to click while a contact is outstanding.
   */
  const restoreCheckpoint = async (checkpointId: string): Promise<void> => {
    try {
      const res = await fetch(`/api/claims/checkpoints/${encodeURIComponent(checkpointId)}/restore`, {
        method: 'POST',
      });
      if (res.ok) {
        const data = await res.json();
        if (data.claim) setClaim(data.claim);
        applyAwaiting(data);
      }
    } catch (err) {
      console.error('Error restoring checkpoint:', err);
    } finally {
      fetchDbData();
    }
  };

  const execDbCommand = async (command: string): Promise<string> => {
    try {
      const res = await fetch('/api/mongo/cmd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command })
      });
      if (res.ok) {
        const data = await res.json();
        return data.result;
      }
      return '(error) Connection refused';
    } catch (err) {
      return '(error) Communication failure';
    }
  };

  useEffect(() => {
    loadTemplates();
    loadSessions();
    // Immediate hydrate so a browser refresh restores the active interaction.
    fetchDbData();
    pollingRef.current = setInterval(() => {
      fetchDbData();
    }, 2500);

    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  useEffect(() => {
    if (!claim) loadSessions();
  }, [claim]);

  useEffect(() => {
    const onHash = () => {
      setPage(window.location.hash === '#/mongo' ? 'mongo' : 'home');
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Three distinct end-states now that progression is event-driven: still
  // stepping, out of steps but held for adjuster sign-off, and truly resolved.
  const stepsExhausted = claim ? claim.currentStepIndex >= claim.timeline.length : false;
  const awaitingApproval = claim ? claim.status === 'AWAITING_APPROVAL' : false;
  const claimResolved = stepsExhausted && !awaitingApproval;
  const isWaitingOnReply =
    !!awaiting ||
    (claim ? claim.timeline.some(step => step.subSteps.some(sub => sub.contactStatus === 'awaiting_reply')) : false);

  return (
    <div
      className={`min-h-screen bg-mdb-canvas text-mdb-ink antialiased flex flex-col items-center pt-8 ${layout.pagePad}`}
    >
      <header className={`w-full ${layout.mainClass} flex items-center pb-3`}>
        <button
          type="button"
          onClick={goHome}
          className="brand-logo"
          aria-label="ConquerContext home"
        >
          <MongoLeaf className="brand-logo-mark" title="ConquerContext" />
          <h1 className="brand-logo-word">
            <span className="brand-logo-conquer">Conquer</span>
            <span className="brand-logo-context">Context</span>
          </h1>
        </button>
      </header>

      <main className={`w-full ${layout.mainClass} flex flex-col gap-8 pb-28`}>
        {page === 'mongo' ? (
          <div className="w-full flex flex-col gap-4 animate-in fade-in duration-300">
            <div className="flex flex-col gap-1">
              <h2 className="text-2xl font-semibold text-mdb-ink tracking-tight font-display">MongoDB memory &amp; state</h2>
              <p className="text-sm text-mdb-slate">
                Claim state, long-term agent memory, the checkpoint lineage, pub/sub, and command
                logs.
              </p>
            </div>
            <MongoDashboard
              keys={dbKeys}
              logs={dbLogs}
              pubsub={dbPubsub}
              stats={dbStats}
              onRefresh={fetchDbData}
              onExecCommand={execDbCommand}
              claim={claim}
              awaiting={awaiting}
              memories={memories}
              memoryStatus={memoryStatus}
              checkpoints={checkpoints}
              onRestoreCheckpoint={restoreCheckpoint}
            />
          </div>
        ) : claim ? (
          <ClaimTimeline
            claim={claim}
            onRunStep={runAgentStep}
            loading={loading}
            onReset={handleStopWorkflow}
            claimFinished={claimResolved}
            awaiting={awaiting}
            onApprovePayout={approvePayout}
            approving={approving}
            approveError={approveError}
          />
        ) : (
          <div className="flex flex-col gap-8 w-full">
            <ClaimList
              claims={templates}
              onSelectClaim={loadClaim}
            />

            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <h3 className="font-bold text-mdb-ink flex items-center gap-2 text-sm tracking-tight">
                  <Activity className="size-4 text-mdb-forest" />
                  Live System Events
                </h3>
                <button
                  type="button"
                  onClick={goMongo}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-mdb-border bg-mdb-card text-sm font-medium text-mdb-ink hover:bg-mdb-mint hover:border-mdb-forest/30 transition"
                >
                  <Database className="size-4 text-mdb-forest" />
                  Open MongoDB page
                </button>
              </div>

              <div className="rounded-2xl border border-mdb-border bg-mdb-black overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-2 border-b border-white/10 bg-[#023430]">
                  <span className="size-2.5 rounded-full bg-red-500/80" />
                  <span className="size-2.5 rounded-full bg-amber-400/80" />
                  <span className="size-2.5 rounded-full bg-mdb-leaf" />
                  <span className="ml-2 text-[11px] font-mono text-mdb-slate">conquer — system.log</span>
                </div>
                <div
                  className="font-mono text-[12px] leading-relaxed px-4 py-3 max-h-[200px] overflow-y-auto space-y-1"
                  role="log"
                  aria-live="polite"
                  aria-label="System event log"
                >
                  {(() => {
                    const defaultLogs = [
                      { timestamp: new Date(Date.now() - 3600000).toLocaleTimeString(), level: 'INFO', msg: 'MongoDB ready — waiting for claim load.' },
                      { timestamp: new Date(Date.now() - 3400000).toLocaleTimeString(), level: 'INFO', msg: 'Webhook routes registered.' },
                      { timestamp: new Date(Date.now() - 2800000).toLocaleTimeString(), level: 'COMMAND', msg: 'Idle — select a claim to start the agent.' },
                    ];
                    const displayLogs = (dbLogs.length > 0 ? dbLogs : defaultLogs).slice(0, 12);
                    return displayLogs.map((log, i) => (
                      <div key={`${log.timestamp}-${i}`} className="flex gap-3 items-start break-words">
                        <span className="text-zinc-500 shrink-0 tabular-nums">{log.timestamp}</span>
                        <span className={`shrink-0 w-16 font-semibold ${levelColor(log.level)}`}>
                          {log.level}
                        </span>
                        <span className="text-zinc-200 min-w-0">{log.msg}</span>
                      </div>
                    ));
                  })()}
                </div>
              </div>
            </div>

            {sessions.length > 0 && (
              <div className="flex flex-col gap-4">
                <h3 className="font-bold text-mdb-ink flex items-center gap-2 text-sm tracking-tight">
                  <History className="size-4 text-mdb-forest" />
                  Saved interactions
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {sessions.slice(0, 12).map(session => (
                    <div
                      key={session.sessionId}
                      className="bg-mdb-elevated rounded-2xl p-4 border border-mdb-border flex flex-col gap-3"
                    >
                      <div className="flex items-center justify-between border-b border-mdb-border pb-2.5">
                        <span className="text-[13px] text-mdb-slate">Session</span>
                        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium text-mdb-forest border border-mdb-border bg-white">
                          {session.endReason}
                        </span>
                      </div>
                      <h3 className="font-semibold text-mdb-ink leading-snug text-[14px] tracking-tight">
                        {session.claimantName}
                      </h3>
                      <p className="text-[12px] text-mdb-slate">
                        {session.claimId} · {session.claimType} · step{' '}
                        {Math.min(session.currentStepIndex + 1, session.stepCount)}/{session.stepCount}
                      </p>
                      <button
                        type="button"
                        onClick={() => resumeSession(session.sessionId)}
                        disabled={loading}
                        aria-label={`Resume session for ${session.claimantName}`}
                        className="self-start inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold
                          bg-mdb-forest text-white hover:bg-mdb-black disabled:opacity-50 transition"
                      >
                        Resume
                        <ArrowRight className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      <BottomDock
        page={page}
        claim={claim}
        layoutWidth={layoutWidth}
        loading={loading}
        claimResolved={claimResolved}
        awaitingApproval={awaitingApproval}
        isWaitingOnReply={isWaitingOnReply}
        onLayoutWidth={handleLayoutWidth}
        onGoHome={goHome}
        onGoMongo={goMongo}
        onReset={handleReset}
        onStopWorkflow={handleStopWorkflow}
        onRunStep={runAgentStep}
        onReviewSignoff={() =>
          document
            .getElementById('payout-approval-panel')
            ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
      />
    </div>
  );
}
