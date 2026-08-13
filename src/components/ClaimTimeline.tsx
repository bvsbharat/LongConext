/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { AwaitingContact, Claim, ReplySource, TimelineStep, SubStep } from '../types';
import {
  Brain,
  Cpu,
  Globe,
  Phone,
  FileText,
  Database,
  MessageSquare,
  Mail,
  Calendar,
  ShieldCheck,
  ShieldAlert,
  Hourglass,
  FastForward,
  CheckCircle2,
  Circle,
  Clock,
  MessageCircle,
  AlertTriangle,
  ArrowRight,
  User,
  Sparkles,
  Layers,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface ClaimTimelineProps {
  claim: Claim;
  onRunStep: () => void;
  loading: boolean;
  onReset: () => void;
  claimFinished: boolean;
  awaiting?: AwaitingContact | null;
  onApprovePayout?: () => void;
  approving?: boolean;
  approveError?: string | null;
}

// Long-horizon waits can legitimately run for days, so the format degrades
// gracefully instead of rendering four-digit minutes.
const formatElapsed = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
};

const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const formatUsd = (value: number) =>
  `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Where a rendered dialogue came from. Only 'inbound' is a real person's words, so it is
// the only one that gets an unqualified treatment. An ABSENT replySource is mapped to
// 'unknown' and shown as not-real by design: under-labelling a genuine reply is harmless,
// while a fabricated conversation passing as genuine is the failure this exists to prevent.
const REPLY_SOURCE_META: Record<
  ReplySource | 'unknown',
  { label: string; Icon: React.ComponentType<{ className?: string }>; pill: string }
> = {
  inbound: {
    label: 'Real reply received',
    Icon: CheckCircle2,
    pill: 'bg-mdb-forest/30 text-mdb-leaf border-mdb-leaf/30',
  },
  synthesized: {
    label: 'Synthesized — not a real reply',
    Icon: Sparkles,
    pill: 'bg-amber-950/40 text-amber-300 border-amber-700/40',
  },
  fixture: {
    label: 'Sample dialogue — never sent',
    Icon: FileText,
    pill: 'bg-mdb-elevated text-mdb-slate border-mdb-border',
  },
  unknown: {
    label: 'Unverified — not a confirmed reply',
    Icon: Circle,
    pill: 'bg-mdb-elevated text-mdb-slate border-mdb-border',
  },
};

const CHANNEL_COPY: Record<AwaitingContact['channel'], { waiting: string; sent: string; resolves: string }> = {
  sms: { waiting: 'Waiting for reply…', sent: 'Message sent', resolves: 'a reply arrives' },
  email: { waiting: 'Waiting for reply…', sent: 'Email sent', resolves: 'a reply arrives' },
  call: {
    waiting: 'Call in progress — answer it; step advances only after the conversation finishes…',
    sent: 'Call placed',
    resolves: 'the call completes with a reply (missed/no-answer stays parked here)',
  },
};

const channelIcon = (channel: AwaitingContact['channel']) => {
  if (channel === 'call') return Phone;
  if (channel === 'email') return Mail;
  return MessageSquare;
};

export const ClaimTimeline: React.FC<ClaimTimelineProps> = ({
  claim,
  onRunStep,
  loading,
  onReset,
  claimFinished,
  awaiting,
  onApprovePayout,
  approving,
  approveError,
}) => {
  // Expanded conversations log tracking
  const [expandedChats, setExpandedChats] = useState<Record<string, boolean>>({});
  // Two-stage confirm so releasing funds is never a single reflex click
  const [confirmingPayout, setConfirmingPayout] = useState(false);
  // Ticks once a second while the agent is waiting so elapsed time stays live
  const [now, setNow] = useState(() => Date.now());

  const sentAtMs = awaiting ? Date.parse(awaiting.sentAt) : NaN;
  const hasSentAt = Number.isFinite(sentAtMs);

  useEffect(() => {
    if (!awaiting) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [awaiting?.subStepId, awaiting?.sentAt]);

  const awaitingApproval = claim.status === 'AWAITING_APPROVAL';
  const elapsedLabel = hasSentAt ? formatElapsed(now - sentAtMs) : null;
  const WaitChannelIcon = awaiting ? channelIcon(awaiting.channel) : null;

  // Collapse the confirm step whenever the gate closes or a different claim loads
  useEffect(() => {
    if (!awaitingApproval) setConfirmingPayout(false);
  }, [awaitingApproval, claim.id]);

  // What the adjuster is signing off on. `proposedPayout`/`proposedDeductible` are
  // drafted when the claim enters AWAITING_APPROVAL and are the same figures the
  // settlement pays out; resolutionCheck is only a fallback for older records.
  const payoutAmount = isAmount(claim.proposedPayout)
    ? claim.proposedPayout
    : isAmount(claim.resolutionCheck?.amount)
      ? claim.resolutionCheck.amount
      : undefined;

  const deductible = isAmount(claim.proposedDeductible)
    ? claim.proposedDeductible
    : isAmount(payoutAmount) && payoutAmount < claim.claimAmount
      ? claim.claimAmount - payoutAmount
      : undefined;

  // No figure, no authorization — an unknown amount must never be approvable.
  const payoutUnknown = !isAmount(payoutAmount);

  const toggleChat = (subStepId: string) => {
    setExpandedChats(prev => ({
      ...prev,
      [subStepId]: !prev[subStepId]
    }));
  };

  // Always show the full horizon (typically 4 day-columns). Pending stages render
  // as locked skeletons; sub-steps inside the active column still unlock one at a time.
  const stepCount = Math.max(1, claim.timeline.length);
  const completedCount = claim.timeline.filter(s => s.status === 'completed').length;
  const gridColsClass =
    stepCount === 1
      ? 'grid-cols-1 max-w-md'
      : stepCount === 2
        ? 'grid-cols-1 lg:grid-cols-2'
        : stepCount === 3
          ? 'grid-cols-1 lg:grid-cols-3'
          : 'grid-cols-1 lg:grid-cols-4';
  const progressWidthPct =
    stepCount <= 1
      ? 0
      : Math.min(100, Math.max(0, (completedCount / (stepCount - 1)) * 100));
  const trackInsetPct = 100 / (stepCount * 2);

  // Style mapping helper for active/completed sub-steps
  const getSubStepStyles = (sub: SubStep) => {
    const isOutcome = sub.type === 'outcome' || sub.systemName.toLowerCase() === 'outcome';

    if (isOutcome) {
      return {
        container: 'bg-mdb-forest border border-mdb-forest rounded-xl p-3.5 flex flex-col gap-2',
        badge: 'inline-flex w-max px-2 py-0.5 rounded-full text-[11px] font-medium tracking-tight bg-transparent text-mdb-mint border border-white/20',
        desc: 'text-white text-[13px] leading-snug',
      };
    }

    switch (sub.type) {
      case 'horizon':
        return {
          container: 'bg-mdb-elevated border border-mdb-leaf/20 rounded-xl p-3.5 flex flex-col gap-2',
          badge: 'inline-flex w-max px-2 py-0.5 rounded-full text-[11px] font-medium tracking-tight bg-mdb-black text-mdb-leaf border border-mdb-leaf/30',
          desc: 'text-mdb-mint text-[13px] leading-snug',
        };
      case 'phone':
      case 'sms':
        return {
          container: 'bg-mdb-forest/20 border border-mdb-leaf/25 rounded-xl p-3.5 flex flex-col gap-2',
          badge: `inline-flex w-max px-2 py-0.5 rounded-full text-[11px] font-medium tracking-tight bg-mdb-black text-mdb-leaf border border-mdb-leaf/30`,
          desc: 'text-mdb-leaf text-[13px] leading-snug',
        };
      case 'api':
      case 'tool':
      default:
        return {
          container: 'bg-mdb-spruce/60 border border-mdb-mint/20 rounded-xl p-3.5 flex flex-col gap-2',
          badge: 'inline-flex w-max px-2 py-0.5 rounded-full text-[11px] font-medium tracking-tight bg-mdb-black text-mdb-mint border border-mdb-mint/25',
          desc: 'text-mdb-mint text-[13px] leading-snug',
        };
    }
  };

  return (
    <div className="flex flex-col gap-6" id="claim-timeline-panel">
      {/* Long-horizon wait banner — the agent is parked on an outbound contact */}
      <AnimatePresence>
        {awaiting && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="bg-amber-950/40 border border-amber-700/40 rounded-2xl px-5 py-4 flex items-center justify-between gap-4"
            id="awaiting-reply-banner"
          >
            <div className="flex items-center gap-3">
              <span className="flex h-2 w-2 relative shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
              </span>
              <div className="flex flex-col gap-0.5">
                <span className="text-[13px] font-semibold text-amber-200 tracking-tight flex items-center gap-1.5">
                  {WaitChannelIcon && <WaitChannelIcon className="size-3.5 text-amber-300" />}
                  {CHANNEL_COPY[awaiting.channel].waiting}
                </span>
                <span className="text-[12px] text-amber-200/80 leading-snug">
                  {CHANNEL_COPY[awaiting.channel].sent} to {claim.claimantName}. The agent stays on this claim and
                  advances on its own the moment {CHANNEL_COPY[awaiting.channel].resolves} — no action needed.
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {awaiting.attempt > 1 && (
                <span className="inline-flex w-max px-2 py-0.5 rounded-full text-[11px] font-medium tracking-tight bg-mdb-black text-amber-300 border border-amber-700/40">
                  Attempt {awaiting.attempt}
                </span>
              )}
              {elapsedLabel && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-semibold tracking-tight bg-mdb-black text-amber-200 border border-amber-700/40 tabular-nums">
                  <Hourglass className="size-3 text-amber-600" />
                  {elapsedLabel}
                </span>
              )}
              {/* Force Advance lives here, with the state it acts on, rather than in the
                  global header -- it is a demo override, not a primary action. */}
              <button
                type="button"
                onClick={onRunStep}
                disabled={loading}
                title="Demo/test override: skips the real wait for the inbound reply and advances the claim anyway."
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold border border-amber-600/50 text-amber-100 bg-mdb-black hover:bg-amber-950/60 disabled:opacity-50 disabled:cursor-not-allowed transition shrink-0"
              >
                <FastForward className="size-3.5" />
                {loading ? 'Advancing...' : 'Force Advance'}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* The whole agent flow sits on one elevated card, matching the reference layout:
          eyebrow + title, a channels/systems meta row, then the timeline. */}
      <div className="bg-mdb-card rounded-[20px] border border-mdb-border px-8 sm:px-10 md:px-14 pt-8 pb-10">

        {/* Card header */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] text-mdb-slate">For insurers</span>
          <h2 className="text-[26px] leading-tight font-semibold text-mdb-fog tracking-tight">
            From FNOL to claim resolution
          </h2>
        </div>

        {/* Channels / systems meta row */}
        <div className="mt-6 pt-4 border-t border-mdb-border flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] text-mdb-slate">
          <span className="flex items-center gap-2">
            <span className="text-mdb-slate">Channels:</span>
            <span className="inline-flex items-center gap-1.5"><Phone className="size-3.5 text-mdb-slate" />Phone</span>
            <span className="inline-flex items-center gap-1.5"><MessageSquare className="size-3.5 text-mdb-slate" />SMS</span>
            <span className="inline-flex items-center gap-1.5"><Mail className="size-3.5 text-mdb-slate" />Email</span>
          </span>
          <span className="hidden md:inline-block w-px h-4 bg-mdb-border" />
          <span className="flex items-center gap-2">
            <span className="text-mdb-slate">Systems:</span>
            <span className="inline-flex items-center gap-1.5"><Layers className="size-3.5 text-mdb-slate" />Guidewire, Duck Creek &amp; more</span>
          </span>
        </div>

        <div className="mt-2 pt-4 border-t border-mdb-border" />

      {/* Timeline diamonds — full 4-step horizon */}
      <div className="relative pt-2 pb-2 px-1">
        <div
          className="absolute top-[34px] h-[1px] bg-mdb-border transition-all duration-500"
          style={{ left: `${trackInsetPct}%`, right: `${trackInsetPct}%` }}
        />
        <div
          className="absolute top-[34px] h-[1px] bg-[#00ED64] transition-all duration-500 ease-out"
          style={{
            left: `${trackInsetPct}%`,
            width: `calc(${100 - trackInsetPct * 2}% * ${progressWidthPct / 100})`,
          }}
        />

        <div className={`grid ${gridColsClass} gap-6 text-center relative z-10`}>
          {claim.timeline.map((step) => {
            const isActive = step.status === 'active';
            const isPending = step.status === 'pending';
            return (
              <div key={step.id} className="flex flex-col items-center gap-3">
                <span
                  className={`text-[13px] font-medium tracking-wide transition duration-300 ${
                    isPending ? 'text-mdb-slate' : 'text-mdb-leaf'
                  }`}
                >
                  {step.timeLabel}
                </span>
                {isPending ? (
                  <div className="w-2.5 h-2.5 bg-mdb-border rotate-45 transition-all duration-300 mt-1" />
                ) : (
                  <div
                    className={`w-3 h-3 rotate-45 bg-[#00ED64] transition-all duration-300 mt-0.5 ${
                      isActive ? 'ring-2 ring-mdb-leaf/50 ring-offset-2 ring-offset-mdb-card' : ''
                    }`}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Workflow columns — all four stages; pending ones stay locked skeletons */}
      <div className={`grid ${gridColsClass} gap-5 items-start mt-1`}>
        {claim.timeline.map((step) => {
          const isCompleted = step.status === 'completed';
          const isActive = step.status === 'active';
          const isPending = step.status === 'pending';

          if (isPending) {
            return (
              <div
                key={step.id}
                className="bg-mdb-elevated rounded-2xl p-5 border border-mdb-border flex flex-col gap-4 opacity-50 select-none"
                aria-hidden="true"
              >
                <div className="flex items-center justify-between border-b border-mdb-border pb-3">
                  <div className="h-3 bg-mdb-border rounded w-12" />
                  <div className="h-5 bg-mdb-border rounded-md w-12 border border-mdb-border" />
                </div>
                <div className="flex flex-col gap-1.5 mt-1 min-h-[108px]">
                  <div className="h-3.5 bg-mdb-border rounded w-[85%]" />
                  <div className="h-3.5 bg-mdb-border rounded w-[50%]" />
                </div>
                <div className="flex flex-col gap-3 mt-2 pt-2">
                  {step.subSteps.map((sub) => (
                    <div
                      key={sub.id}
                      className="bg-mdb-black/50 border border-mdb-border rounded-xl p-3.5 flex flex-col gap-2"
                    >
                      <div className="h-4.5 bg-mdb-border rounded-full w-14" />
                      <div className="h-3 bg-mdb-border rounded w-[80%] mt-1" />
                    </div>
                  ))}
                </div>
              </div>
            );
          }

          return (
            <div key={step.id} className="flex flex-col relative">
              
              {/* Primary step card — fixed min height so all four Signal cards align
                  and the stem to the first workflow card is the same length. */}
              <div 
                className={`bg-mdb-elevated rounded-2xl p-4 border transition-all duration-300 flex flex-col gap-3 relative min-h-[108px] ${
                  isActive 
                    ? 'border-mdb-leaf/40 shadow-md ring-1 ring-mdb-leaf/20' 
                    : 'border-mdb-border'
                }`}
                id={`step-card-${step.id}`}
              >
                {/* Header signal title */}
                <div className="flex items-center justify-between border-b border-mdb-border pb-2.5">
                  <span className="text-[13px] text-mdb-slate font-sans">
                    Signal
                  </span>
                  
                  {/* System Badge */}
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium text-mdb-mint border border-mdb-border bg-mdb-black">
                    <Layers className="size-3 text-mdb-slate" />
                    EHR
                  </span>
                </div>

                {/* Main Headline text */}
                <h3 className="font-semibold text-mdb-fog leading-snug text-[14px] tracking-tight">
                  {step.signal}
                </h3>
              </div>

              {/* Agent Memory — persisted context for this stage (and learned contacts) */}
              {(isActive || isCompleted) && (step.agentMemory || claim.workingMemory) && (
                <div className="mt-3 rounded-xl border border-mdb-leaf/25 bg-mdb-forest/20 px-3.5 py-3 flex flex-col gap-1.5">
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-tight text-mdb-leaf">
                    <Brain className="size-3.5 text-mdb-leaf" />
                    Agent Memory
                  </span>
                  <p className="text-[12px] text-mdb-fog/90 leading-relaxed whitespace-pre-line">
                    {isActive && claim.workingMemory
                      ? claim.workingMemory
                      : step.agentMemory}
                  </p>
                </div>
              )}

              {/* Stem: Signal / memory → first unlocked workflow card */}
              <div className="relative h-9 ml-[18px]" aria-hidden="true">
                <div className="absolute left-0 top-0 bottom-0 w-[1.5px] bg-mdb-border" />
              </div>

              {/* Sub steps: only completed + current are live; later ones stay locked */}
              <div className="flex flex-col">
                {(() => {
                  const firstOpen = step.subSteps.findIndex(s => s.contactStatus !== 'done');
                  const unlockThrough = firstOpen === -1 ? step.subSteps.length - 1 : firstOpen;
                  return step.subSteps.map((sub, sidx) => {
                  const isLocked = (isActive || isCompleted) && sidx > unlockThrough;
                  if (isLocked) {
                    return (
                      <div key={sub.id} className="relative pl-7 pb-3 opacity-45 select-none" aria-hidden="true">
                        <div className="absolute left-[18px] top-0 w-[1.5px] bg-mdb-border h-[18px]" />
                        <div className="absolute left-[18px] top-0 w-3.5 h-[18px] border-l-[1.5px] border-b-[1.5px] border-mdb-border rounded-bl-[10px] pointer-events-none" />
                        <div className="bg-mdb-black/50 border border-mdb-border rounded-xl p-3.5 flex flex-col gap-2">
                          <div className="h-3 bg-mdb-border rounded w-24" />
                          <div className="h-3 bg-mdb-border rounded w-[80%]" />
                        </div>
                      </div>
                    );
                  }
                  const isLastSubStep = sidx === unlockThrough;
                  const styles = getSubStepStyles(sub);
                  const isChattable = !!sub.chatLog && sub.chatLog.length > 0;
                  const replyMeta = REPLY_SOURCE_META[sub.replySource ?? 'unknown'];
                  const dialogueIsReal = sub.replySource === 'inbound';

                  // The agent is parked on this contact until an inbound webhook resolves it
                  const isAwaited = awaiting?.subStepId === sub.id;
                  const isWaiting = isAwaited || sub.contactStatus === 'awaiting_reply';
                  const waitChannel: AwaitingContact['channel'] = isAwaited
                    ? awaiting!.channel
                    : sub.type === 'phone'
                      ? 'call'
                      : sub.type === 'sms'
                        ? 'sms'
                        : 'email';

                  // By default expand the chats on active column so it looks beautiful
                  const isChatOpen = expandedChats[sub.id] !== undefined 
                    ? expandedChats[sub.id] 
                    : (isActive || isCompleted); // Default opened for active/completed logs

                  return (
                    <div key={sub.id} className="relative pl-7 pb-3">
                      
                      {/* Vertical main connector wire */}
                      <div 
                        className={`absolute left-[18px] top-0 w-[1.5px] bg-mdb-border transition ${
                          isLastSubStep ? 'h-[18px]' : 'bottom-0'
                        }`} 
                      />

                      {/* Smooth curved branch hand */}
                      <div className="absolute left-[18px] top-0 w-3.5 h-[18px] border-l-[1.5px] border-b-[1.5px] border-mdb-border rounded-bl-[10px] pointer-events-none" />

                      {/* Sub step capsule container */}
                      <div className={`${styles.container} transition-all duration-300 relative shadow-xs ${
                        isWaiting ? 'ring-1 ring-amber-500/40' : ''
                      }`}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex flex-col gap-2 w-full">
                            
                            {/* Header Label Pill */}
                            <span className={styles.badge}>
                              {sub.systemName} {sub.techType ? `• ${sub.techType}` : ''}
                            </span>

                            {/* Substep explanation description */}
                            <p className={styles.desc}>
                              {sub.description}
                            </p>
                          </div>
                        </div>

                        {/* Waiting-for-reply footer — intentionally parked, not stalled */}
                        {isWaiting && (
                          <div className="mt-2.5 pt-2.5 border-t border-current/10 flex items-center justify-between gap-2 flex-wrap">
                            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-amber-300 tracking-tight">
                              <span className="flex h-1.5 w-1.5 relative shrink-0">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-500" />
                              </span>
                              {CHANNEL_COPY[waitChannel].waiting}
                            </span>
                            {isAwaited && elapsedLabel && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-tight bg-mdb-black text-amber-300 border border-amber-700/40 tabular-nums">
                                <Clock className="size-2.5" />
                                {elapsedLabel}
                              </span>
                            )}
                          </div>
                        )}

                        {/* Dropdown dialog bubble section for Phone/SMS channels */}
                        {isChattable && (
                          <div className="mt-2.5 pt-2.5 border-t border-current/10 flex flex-col gap-2">
                            {/* Toggle click button + provenance of the dialogue below it */}
                            <div className="flex items-center justify-between gap-2 flex-wrap">
                              <button
                                type="button"
                                onClick={() => toggleChat(sub.id)}
                                className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider hover:opacity-80 transition cursor-pointer self-start"
                              >
                                <MessageCircle className="size-3" />
                                <span>{isChatOpen ? 'Hide dialogue' : 'Inspect phone/sms logs'}</span>
                                {isChatOpen ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                              </button>

                              <span
                                className={`inline-flex items-center gap-1 w-max px-2 py-0.5 rounded-full text-[10px] font-medium tracking-tight border ${replyMeta.pill}`}
                              >
                                <replyMeta.Icon className="size-2.5" />
                                {replyMeta.label}
                              </span>
                            </div>

                            {/* Expanded Conversation Bubble View */}
                            <AnimatePresence initial={false}>
                              {isChatOpen && (
                                <motion.div
                                  initial={{ height: 0, opacity: 0 }}
                                  animate={{ height: 'auto', opacity: 1 }}
                                  exit={{ height: 0, opacity: 0 }}
                                  className="overflow-hidden flex flex-col gap-2.5 mt-2"
                                >
                                  {sub.chatLog?.map((msg, midx) => {
                                    const isAgent = msg.sender === 'agent';

                                    return (
                                      <div 
                                        key={midx} 
                                        className={`flex flex-col gap-1 max-w-[85%] ${
                                          isAgent ? 'self-start' : 'self-end items-end'
                                        }`}
                                      >
                                        {/* Sender Label name */}
                                        <div className="flex items-center gap-1 text-[9px] font-bold text-mdb-slate uppercase tracking-tight">
                                          {isAgent ? (
                                            <>
                                              <Sparkles className="size-2.5 text-mdb-leaf animate-pulse" />
                                              <span>Agent</span>
                                            </>
                                          ) : (
                                            <>
                                              <User className="size-2.5 text-mdb-slate" />
                                              <span>{msg.name}</span>
                                            </>
                                          )}
                                        </div>

                                        {/* Physical text speech balloon. Dashed when the exchange
                                            did not actually happen, on both sides — for a fixture
                                            or a synthesized reply the agent's turn is invented too. */}
                                        <div className={`px-3.5 py-2 rounded-2xl text-[11px] leading-relaxed shadow-2xs border ${
                                          dialogueIsReal ? '' : 'border-dashed '
                                        }${
                                          isAgent
                                            ? 'bg-mdb-forest/30 border-mdb-leaf/20 text-mdb-fog rounded-tl-none'
                                            : 'bg-mdb-black border-mdb-border text-mdb-fog rounded-tr-none'
                                        }`}>
                                          {msg.text}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                });
                })()}
              </div>
            </div>
          );
        })}
      </div>
      </div>{/* /flow card */}

      {/* Active Agent Events / Memory Log */}
      <div className="mt-8 flex flex-col gap-4">
        <h3 className="font-bold text-mdb-fog flex items-center gap-2 text-sm tracking-tight">
          <Sparkles className="size-4 text-mdb-leaf" />
          Agent Reasoning Log
        </h3>
        <div className={`grid ${gridColsClass} gap-4`}>
          {claim.timeline.map((step) => {
            const isActive = step.status === 'active';
            const isPending = step.status === 'pending';

            return (
              <div
                key={`memory-${step.id}`}
                className={`p-4 rounded-xl border transition-all duration-300 flex flex-col gap-2 ${
                  isActive
                    ? 'bg-mdb-forest/20 border-mdb-leaf/30 shadow-sm ring-1 ring-mdb-leaf/20'
                    : isPending
                      ? 'bg-mdb-elevated/50 border-mdb-border opacity-50'
                      : 'bg-mdb-card border-mdb-border'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`text-[11px] font-bold tracking-wider uppercase ${
                      isActive ? 'text-mdb-leaf' : isPending ? 'text-mdb-slate' : 'text-mdb-slate'
                    }`}
                  >
                    {step.timeLabel}
                  </span>
                  {isActive && (
                    <span className="flex h-2 w-2 relative">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00ED64] opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-[#00ED64]" />
                    </span>
                  )}
                </div>
                {isPending ? (
                  <div className="flex flex-col gap-1.5 mt-1">
                    <div className="h-2.5 bg-mdb-border rounded w-[90%]" />
                    <div className="h-2.5 bg-mdb-border rounded w-[60%]" />
                  </div>
                ) : (
                  <p className="text-[13px] text-mdb-fog/85 leading-relaxed font-sans whitespace-pre-line">
                    {isActive && claim.workingMemory ? claim.workingMemory : step.agentMemory}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Human-in-the-loop gate — nothing is disbursed until an adjuster signs off */}
      <AnimatePresence>
        {awaitingApproval && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="mt-6 border border-amber-700/40 bg-amber-950/30 rounded-2xl p-6"
            id="payout-approval-panel"
          >
            <div className="flex items-center gap-2 mb-1 text-amber-200">
              <ShieldAlert className="size-6 text-amber-400 fill-amber-900/40" />
              <h3 className="text-lg font-bold tracking-tight">Adjuster Sign-off Required</h3>
            </div>
            <p className="text-[13px] text-amber-200/80 leading-relaxed mb-5 max-w-3xl">
              The agent has finished working this claim and drafted a settlement. Payment is held here for human review
              — an adjuster must sign off before any funds leave the account.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
              {/* What exactly is being approved */}
              <div className="bg-mdb-card rounded-xl p-5 border border-amber-700/40 flex flex-col gap-3">
                <h4 className="text-xs font-bold text-mdb-slate uppercase tracking-wider">
                  Under Review
                </h4>

                <div className="flex flex-col divide-y divide-mdb-border">
                  <div className="flex items-center justify-between py-2">
                    <span className="text-[12px] text-mdb-slate">Claimant</span>
                    <span className="text-[13px] font-semibold text-mdb-fog">{claim.claimantName}</span>
                  </div>
                  <div className="flex items-center justify-between py-2">
                    <span className="text-[12px] text-mdb-slate">Claim / Policy</span>
                    <span className="text-[12px] font-mono text-mdb-mint">{claim.id} · {claim.policyNumber}</span>
                  </div>

                  {/* Settlement arithmetic, spelled out so the total is never unexplained */}
                  <div className="flex items-center justify-between py-2">
                    <span className="text-[12px] text-mdb-slate">Claim amount</span>
                    <span className="text-[13px] font-mono text-mdb-mint tabular-nums">
                      {formatUsd(claim.claimAmount)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-2">
                    <span className="text-[12px] text-mdb-slate">Less deductible</span>
                    <span className="text-[13px] font-mono text-mdb-mint tabular-nums">
                      {deductible !== undefined ? `−${formatUsd(deductible)}` : 'Not itemized'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-2.5 border-t-2 border-mdb-border">
                    <span className="text-[12px] font-semibold text-mdb-fog">Net payout</span>
                    {payoutUnknown ? (
                      <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-red-700">
                        <AlertTriangle className="size-3.5" />
                        Could not be determined
                      </span>
                    ) : (
                      <span className="text-[15px] font-mono font-bold text-amber-200 tabular-nums">
                        {formatUsd(payoutAmount)}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Deliberate two-stage approval action */}
              <div className="bg-mdb-card rounded-xl p-5 border border-amber-700/40 flex flex-col justify-between h-full gap-4">
                <div className="flex flex-col gap-2">
                  <h4 className="text-xs font-bold text-mdb-slate uppercase tracking-wider">
                    Release Settlement
                  </h4>
                  <p className="text-[13px] text-mdb-slate leading-relaxed">
                    {payoutUnknown
                      ? 'The settlement amount for this claim could not be determined, so it cannot be authorized here. Approval stays disabled until the orchestrator supplies a proposed payout.'
                      : `Approving sends the settlement to ${claim.claimantName} and closes the claim. This is a real disbursement and cannot be undone from this screen.`}
                  </p>
                </div>

                {approveError && (
                  <div className="bg-red-950/40 border border-red-800/50 rounded-xl px-3.5 py-2.5 flex items-start gap-2">
                    <AlertTriangle className="size-4 text-red-600 shrink-0 mt-px" />
                    <p className="text-[12px] text-red-300 leading-snug break-words">{approveError}</p>
                  </div>
                )}

                <AnimatePresence initial={false} mode="wait">
                  {confirmingPayout ? (
                    <motion.div
                      key="confirm"
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      className="flex flex-col gap-2.5"
                    >
                      <p className="text-[12px] font-semibold text-amber-200 leading-snug">
                        Confirm sign-off as the reviewing adjuster —{' '}
                        {isAmount(payoutAmount) ? formatUsd(payoutAmount) : 'an undetermined amount'} to{' '}
                        {claim.claimantName}.
                      </p>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={onApprovePayout}
                          disabled={approving || !onApprovePayout || payoutUnknown}
                          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white transition ${
                            approving || !onApprovePayout || payoutUnknown
                              ? 'bg-mdb-border cursor-not-allowed'
                              : 'bg-mdb-forest hover:bg-mdb-leaf hover:text-mdb-black'
                          }`}
                        >
                          {approving ? (
                            <>
                              <span className="size-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                              Releasing funds...
                            </>
                          ) : (
                            <>
                              <ShieldCheck className="size-4" />
                              Yes, release funds
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingPayout(false)}
                          disabled={approving}
                          className="px-3 py-2 rounded-lg text-sm font-medium text-mdb-slate hover:text-mdb-fog hover:bg-mdb-elevated transition disabled:cursor-not-allowed"
                        >
                          Cancel
                        </button>
                      </div>
                    </motion.div>
                  ) : (
                    <motion.button
                      key="review"
                      type="button"
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      onClick={() => setConfirmingPayout(true)}
                      disabled={payoutUnknown}
                      className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold text-white transition self-start ${
                        payoutUnknown ? 'bg-mdb-border cursor-not-allowed' : 'bg-amber-500 hover:bg-amber-400 text-mdb-black'
                      }`}
                    >
                      <ShieldCheck className="size-4" />
                      Approve &amp; Send Settlement
                      {!payoutUnknown && <ArrowRight className="size-4" />}
                    </motion.button>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Check Payout Resolution Card (Drafted once RESOLVED / CLOSED) */}
      <AnimatePresence>
        {(claim.status === 'RESOLVED' || claim.status === 'CLOSED') && claim.resolutionCheck && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="mt-6 border border-mdb-leaf/30 bg-mdb-forest/15 rounded-2xl p-6"
            id="resolution-payout-panel"
          >
            <div className="flex items-center gap-2 mb-4 text-mdb-mint">
              <ShieldCheck className="size-6 text-mdb-leaf fill-mdb-forest" />
              <h3 className="text-lg font-bold tracking-tight">SmartAgent Settlement Resolution Approved</h3>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
              {/* Resolution textual justification */}
              <div className="bg-mdb-card rounded-xl p-5 border border-mdb-leaf/25 flex flex-col justify-between h-full">
                <div>
                  <h4 className="text-xs font-bold text-mdb-slate uppercase tracking-wider mb-2">
                    Settlement Narrative & Justification
                  </h4>
                  <p className="text-sm text-mdb-fog/85 leading-relaxed italic mb-4">
                    "{claim.resolutionCheck.resolutionText}"
                  </p>
                  
                  <div className="bg-mdb-forest/20 border border-mdb-leaf/25 rounded-xl p-3.5 flex items-center gap-2.5 mt-2">
                    <Phone className="size-4 text-mdb-leaf shrink-0" />
                    <div className="text-[11px] text-mdb-mint font-sans">
                      <span className="font-semibold block">Need resolution support or payout updates?</span>
                      Call our dedicated hotline: <a href="tel:+12246598896" className="font-bold underline hover:text-mdb-leaf">+1-224-659-8896</a>
                    </div>
                  </div>
                </div>
                <div className="mt-4 pt-4 border-t border-mdb-border text-xs text-mdb-slate flex justify-between">
                  <span>AUDITED BY: Google GenAI Agent</span>
                  <span>TIME: {claim.resolutionCheck.date}</span>
                </div>
              </div>

              {/* Physical check layout print */}
              <div className="bg-mdb-elevated border border-mdb-border rounded-xl p-5 font-mono text-mdb-fog text-xs flex flex-col justify-between border-l-4 border-l-amber-600 relative overflow-hidden h-full">
                {/* Background watermarks */}
                <div className="absolute inset-0 select-none opacity-2 flex items-center justify-center font-bold text-4xl uppercase pointer-events-none rotate-12">
                  INSURANCE DISBURSEMENT
                </div>

                <div className="flex justify-between items-start mb-4 relative">
                  <div>
                    <h4 className="font-bold text-[10px] tracking-wide uppercase text-amber-200">
                      SMARTAGENT CASUALTY CORP
                    </h4>
                    <p className="text-[8px] text-mdb-slate">100 CLOUD RUN WAY, PLATFORM CITY</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] font-bold">CHECK NO. {claim.resolutionCheck.checkNumber}</p>
                    <p className="text-[8px] text-mdb-slate">DATE: {claim.resolutionCheck.date}</p>
                  </div>
                </div>

                <div className="border-y border-amber-950/15 py-3.5 my-1.5 flex justify-between items-center relative">
                  <div className="flex-1">
                    <span className="text-[8px] text-mdb-slate block">PAY TO THE ORDER OF:</span>
                    <span className="font-bold text-sm tracking-tight text-mdb-fog">{claim.resolutionCheck.payTo}</span>
                  </div>
                  <div className="bg-mdb-black border border-mdb-leaf/30 px-3 py-1.5 rounded font-bold text-sm text-mdb-leaf">
                    ${claim.resolutionCheck.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>
                </div>

                <div className="flex justify-between items-end mt-4 pt-2 relative">
                  <div>
                    <span className="text-[8px] text-mdb-slate block">MEMO:</span>
                    <span className="font-bold text-mdb-fog">{claim.resolutionCheck.memo}</span>
                  </div>
                  <div className="text-right border-t border-mdb-border pt-1.5 w-1/3">
                    <span className="font-bold text-[10px] italic text-amber-200 block font-serif">
                      {claim.resolutionCheck.signature}
                    </span>
                    <span className="text-[7px] text-mdb-slate uppercase">AUTHORIZED SIGNATURE</span>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
