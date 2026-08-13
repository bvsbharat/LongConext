import React, { useEffect, useState } from 'react';
import { ClaimTemplateInfo } from '../types';
import {
  FileText,
  Bot,
  UserRound,
  Activity,
  Clock,
  CheckCircle,
  Car,
  HeartPulse,
  Home,
  Phone,
  MessageSquare,
  Mail,
  Layers,
  LayoutGrid,
  Table2,
  type LucideIcon,
} from 'lucide-react';
import { ClaimCardArt } from './ClaimCardArt';

interface ClaimListProps {
  claims: ClaimTemplateInfo[];
  onSelectClaim: (claimKey: string) => void;
}

type ClaimIconStyle = {
  Icon: LucideIcon;
  label: string;
};

type AssignSide = 'user' | 'agentic';
type ClaimView = 'grid' | 'table';

const VIEW_KEY = 'conquer.claimView';

const claimIconForType = (claimType: string): ClaimIconStyle => {
  const t = claimType.toLowerCase();
  if (t.includes('auto') || t.includes('collision') || t.includes('vehicle')) {
    return { Icon: Car, label: 'Auto' };
  }
  if (t.includes('medical') || t.includes('prior') || t.includes('health')) {
    return { Icon: HeartPulse, label: 'Medical' };
  }
  if (t.includes('home') || t.includes('water') || t.includes('property')) {
    return { Icon: Home, label: 'Property' };
  }
  return { Icon: FileText, label: 'Claim' };
};

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

const readClaimView = (): ClaimView => {
  try {
    const stored = localStorage.getItem(VIEW_KEY);
    if (stored === 'grid' || stored === 'table') return stored;
  } catch {
    /* ignore */
  }
  return 'grid';
};

export function ClaimList({ claims, onSelectClaim }: ClaimListProps) {
  // Default: user owns the claim. Flipping to Agentic FNOL opens the details flow.
  const [assignSide, setAssignSide] = useState<Record<string, AssignSide>>({});
  const [view, setView] = useState<ClaimView>(readClaimView);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* ignore */
    }
  }, [view]);

  const sideFor = (claimKey: string): AssignSide => assignSide[claimKey] ?? 'user';

  const handleToggleAssign = (claimKey: string) => {
    const current = sideFor(claimKey);
    if (current === 'agentic') return;

    setAssignSide(prev => ({ ...prev, [claimKey]: 'agentic' }));
    onSelectClaim(claimKey);
  };

  const handleToggleKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    claimKey: string
  ) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleToggleAssign(claimKey);
    }
  };

  const count = Math.max(1, claims.length);
  const gridColsClass =
    count === 1
      ? 'grid-cols-1 max-w-md'
      : count === 2
        ? 'grid-cols-1 md:grid-cols-2'
        : 'grid-cols-1 md:grid-cols-3';
  const trackInsetPct = 100 / (count * 2);

  const assignToggle = (claim: ClaimTemplateInfo, compact = false) => {
    const isAgentic = sideFor(claim.key) === 'agentic';
    return (
      <AssignToggle
        claim={claim}
        isAgentic={isAgentic}
        compact={compact}
        onToggle={() => handleToggleAssign(claim.key)}
        onKeyDown={event => handleToggleKeyDown(event, claim.key)}
      />
    );
  };

  return (
    <div className="bg-mdb-card rounded-[20px] border border-mdb-border px-5 sm:px-7 md:px-8 lg:px-10 pt-8 pb-10">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] text-mdb-slate">For insurers</span>
          <h2 className="text-[26px] leading-tight font-semibold text-mdb-ink tracking-tight">
            From FNOL to claim resolution
          </h2>
        </div>
        <div
          className="inline-flex items-center rounded-lg border border-mdb-border p-0.5 bg-white shrink-0 mt-1"
          role="group"
          aria-label="Claim view"
        >
          <button
            type="button"
            onClick={() => setView('grid')}
            title="Thumbnail view"
            aria-label="Thumbnail view"
            aria-pressed={view === 'grid'}
            className={`inline-flex items-center justify-center size-8 rounded-md transition-colors ${
              view === 'grid'
                ? 'bg-mdb-forest text-white'
                : 'text-mdb-slate hover:bg-mdb-elevated'
            }`}
          >
            <LayoutGrid className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setView('table')}
            title="Table view"
            aria-label="Table view"
            aria-pressed={view === 'table'}
            className={`inline-flex items-center justify-center size-8 rounded-md transition-colors ${
              view === 'table'
                ? 'bg-mdb-forest text-white'
                : 'text-mdb-slate hover:bg-mdb-elevated'
            }`}
          >
            <Table2 className="size-3.5" />
          </button>
        </div>
      </div>

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

      {claims.length === 0 ? (
        <p className="text-sm text-mdb-slate py-8 text-center">No claims available.</p>
      ) : view === 'table' ? (
        <div className="overflow-x-auto rounded-2xl border border-mdb-border bg-white">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-mdb-elevated border-b border-mdb-border">
                <th className="py-3.5 px-5 text-[13px] font-semibold text-mdb-slate uppercase tracking-wider">Claim</th>
                <th className="py-3.5 px-5 text-[13px] font-semibold text-mdb-slate uppercase tracking-wider">Claimant</th>
                <th className="py-3.5 px-5 text-[13px] font-semibold text-mdb-slate uppercase tracking-wider">Type</th>
                <th className="py-3.5 px-5 text-[13px] font-semibold text-mdb-slate uppercase tracking-wider">Amount</th>
                <th className="py-3.5 px-5 text-[13px] font-semibold text-mdb-slate uppercase tracking-wider">Status</th>
                <th className="py-3.5 px-5 text-[13px] font-semibold text-mdb-slate uppercase tracking-wider text-right">
                  Assigned to Agent
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-mdb-border">
              {claims.map(claim => {
                const { Icon, label } = claimIconForType(claim.claimType);
                return (
                  <tr key={claim.key} className="hover:bg-mdb-forest/10 transition-colors">
                    <td className="py-3.5 px-5">
                      <div className="inline-flex items-center gap-3">
                        <ClaimCardArt
                          variant="row"
                          claimKey={claim.key}
                          claimantName={claim.claimantName}
                          claimType={claim.claimType}
                        />
                        <span className="font-mono text-sm text-mdb-ink font-semibold tracking-tight">
                          {claim.id}
                        </span>
                      </div>
                    </td>
                    <td className="py-3.5 px-5">
                      <span className="text-sm text-mdb-ink font-medium">{claim.claimantName}</span>
                    </td>
                    <td className="py-3.5 px-5">
                      <span className="inline-flex items-center gap-1.5 text-sm text-mdb-slate">
                        <Icon className="size-3.5 text-mdb-forest" />
                        {label}
                      </span>
                    </td>
                    <td className="py-3.5 px-5">
                      <span className="text-sm font-mono text-mdb-forest">
                        ${claim.claimAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </span>
                    </td>
                    <td className="py-3.5 px-5">
                      <div className="flex items-center gap-1.5">
                        {claim.status === 'INTAKE' && <Clock className="size-4 text-mdb-forest" />}
                        {claim.status === 'PROCESSING' && <Activity className="size-4 text-amber-500" />}
                        {claim.status === 'RESOLVED' && <CheckCircle className="size-4 text-mdb-forest" />}
                        <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-mdb-mint text-mdb-forest border border-mdb-border">
                          {claim.status}
                        </span>
                      </div>
                    </td>
                    <td className="py-3.5 px-5 text-right">{assignToggle(claim, true)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="relative pt-2 pb-2 px-1">
            <div
              className="absolute top-[34px] h-[1px] bg-mdb-border"
              style={{ left: `${trackInsetPct}%`, right: `${trackInsetPct}%` }}
            />
            <div className={`grid ${gridColsClass} gap-6 text-center relative z-10`}>
              {claims.map(claim => (
                <div key={claim.key} className="flex flex-col items-center gap-3">
                  <span className="text-[13px] font-medium tracking-wide text-mdb-forest">
                    {firstName(claim.claimantName)}
                  </span>
                  <div className="w-3 h-3 rotate-45 bg-[#00ED64] mt-0.5" />
                </div>
              ))}
            </div>
          </div>

          <div className={`grid ${gridColsClass} gap-5 items-start mt-1`}>
            {claims.map(claim => {
              const { Icon, label } = claimIconForType(claim.claimType);

              return (
                <div key={claim.key} className="flex flex-col relative">
                  <div className="bg-mdb-elevated rounded-2xl border border-mdb-border flex flex-col overflow-hidden">
                    <ClaimCardArt
                      claimKey={claim.key}
                      claimantName={claim.claimantName}
                      claimType={claim.claimType}
                    />
                    <div className="p-4 flex flex-col gap-3">
                      <div className="flex items-center justify-between border-b border-mdb-border pb-2.5">
                        <span className="text-[13px] text-mdb-slate font-sans">Claim</span>
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium text-mdb-forest border border-mdb-border bg-white">
                          <Icon className="size-3 text-mdb-slate" />
                          {label}
                        </span>
                      </div>
                      <h3 className="font-semibold text-mdb-ink leading-snug text-[14px] tracking-tight">
                        {claim.claimantName}
                      </h3>
                    </div>
                  </div>

                  <div className="relative h-8 ml-[18px]" aria-hidden="true">
                    <div className="absolute left-0 top-0 bottom-0 w-[1.5px] bg-mdb-border" />
                  </div>

                  <div className="bg-mdb-elevated border border-mdb-border rounded-2xl overflow-hidden">
                    <div className="grid grid-cols-3 divide-x divide-mdb-border">
                      <DetailCell label="Claim ID">
                        <p className="text-mdb-ink text-[13px] leading-snug font-mono font-semibold truncate">
                          {claim.id}
                        </p>
                      </DetailCell>
                      <DetailCell label="Amount">
                        <p className="text-mdb-forest text-[13px] leading-snug font-mono font-semibold">
                          ${claim.claimAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                        </p>
                      </DetailCell>
                      <DetailCell label="Status">
                        <p className="text-mdb-ink text-[13px] leading-snug inline-flex items-center gap-1.5 font-semibold">
                          {claim.status === 'INTAKE' && <Clock className="size-3.5 text-mdb-forest" />}
                          {claim.status === 'PROCESSING' && <Activity className="size-3.5 text-amber-500" />}
                          {claim.status === 'RESOLVED' && <CheckCircle className="size-3.5 text-mdb-forest" />}
                          {claim.status}
                        </p>
                      </DetailCell>
                    </div>

                    <div className="px-3.5 py-3 border-t border-mdb-border bg-white flex flex-col gap-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-mdb-slate">
                          Assigned to
                        </span>
                        <span
                          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                            sideFor(claim.key) === 'agentic'
                              ? 'bg-mdb-mint text-mdb-forest border border-mdb-forest/20'
                              : 'bg-mdb-elevated text-mdb-slate border border-mdb-border'
                          }`}
                        >
                          {sideFor(claim.key) === 'agentic' ? (
                            <>
                              <Bot className="size-3" />
                              Agentic FNOL
                            </>
                          ) : (
                            <>
                              <UserRound className="size-3" />
                              You
                            </>
                          )}
                        </span>
                      </div>
                      {assignToggle(claim)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function AssignToggle({
  claim,
  isAgentic,
  compact = false,
  onToggle,
  onKeyDown,
}: {
  claim: ClaimTemplateInfo;
  isAgentic: boolean;
  compact?: boolean;
  onToggle: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isAgentic}
      onClick={onToggle}
      onKeyDown={onKeyDown}
      aria-label={
        isAgentic
          ? `Claim ${claim.id} assigned to Agentic FNOL`
          : `Assign claim ${claim.id} to Agentic FNOL`
      }
      title={
        isAgentic
          ? 'Assigned to Agentic FNOL'
          : 'Switch to Agentic FNOL to open the claim flow'
      }
      tabIndex={0}
      className={`${compact ? 'inline-flex w-auto' : 'w-full inline-flex'} items-center rounded-xl p-1
        bg-mdb-elevated border border-mdb-border
        hover:border-mdb-forest/40
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mdb-forest focus-visible:ring-offset-2 focus-visible:ring-offset-white
        transition-colors`}
    >
      <span
        className={`${compact ? 'px-2.5' : 'flex-1'} inline-flex items-center justify-center gap-1.5 h-8 rounded-[10px] text-[12px] font-semibold transition-all ${
          !isAgentic ? 'bg-white text-mdb-ink shadow-sm' : 'text-mdb-slate'
        }`}
      >
        <UserRound className="size-3.5" strokeWidth={2.25} />
        You
      </span>
      <span
        className={`${compact ? 'px-2.5' : 'flex-1'} inline-flex items-center justify-center gap-1.5 h-8 rounded-[10px] text-[12px] font-semibold transition-all ${
          isAgentic ? 'bg-mdb-forest text-white shadow-sm' : 'text-mdb-slate'
        }`}
      >
        <Bot className="size-3.5" strokeWidth={2.25} />
        Agent
      </span>
    </button>
  );
}

function DetailCell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="px-3 py-3 flex flex-col gap-1 min-w-0">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-mdb-slate">
        {label}
      </span>
      {children}
    </div>
  );
}
