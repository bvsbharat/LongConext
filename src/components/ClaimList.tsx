import React, { useState } from 'react';
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
  type LucideIcon,
} from 'lucide-react';

interface ClaimListProps {
  claims: ClaimTemplateInfo[];
  onSelectClaim: (claimKey: string) => void;
}

type ClaimIconStyle = {
  Icon: LucideIcon;
  tile: string;
  icon: string;
};

type AssignSide = 'user' | 'agentic';

const claimIconForType = (claimType: string): ClaimIconStyle => {
  const t = claimType.toLowerCase();
  if (t.includes('auto') || t.includes('collision') || t.includes('vehicle')) {
    return {
      Icon: Car,
      tile: 'bg-mdb-forest/25 border-mdb-leaf/30',
      icon: 'text-mdb-leaf',
    };
  }
  if (t.includes('medical') || t.includes('prior') || t.includes('health')) {
    return {
      Icon: HeartPulse,
      tile: 'bg-mdb-spruce border-mdb-mint/25',
      icon: 'text-mdb-mint',
    };
  }
  if (t.includes('home') || t.includes('water') || t.includes('property')) {
    return {
      Icon: Home,
      tile: 'bg-mdb-forest/40 border-mdb-forest',
      icon: 'text-mdb-leaf',
    };
  }
  return {
    Icon: FileText,
    tile: 'bg-mdb-elevated border-mdb-border',
    icon: 'text-mdb-mint',
  };
};

export function ClaimList({ claims, onSelectClaim }: ClaimListProps) {
  // Default: user owns the claim. Flipping to Agentic FNOL opens the details flow.
  const [assignSide, setAssignSide] = useState<Record<string, AssignSide>>({});

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

  return (
    <div className="w-full max-w-5xl mx-auto flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl font-bold tracking-tight text-mdb-fog font-display">Active Claims</h2>
        <p className="text-sm text-mdb-slate">
          Claims start with you. Flip the toggle to Agentic FNOL to hand the flow to Conquer.
        </p>
      </div>

      <div className="bg-mdb-card rounded-2xl border border-mdb-border overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-mdb-spruce/80 border-b border-mdb-border">
              <th className="py-4 px-6 text-[13px] font-semibold text-mdb-mint uppercase tracking-wider">Claim ID</th>
              <th className="py-4 px-6 text-[13px] font-semibold text-mdb-mint uppercase tracking-wider">Claimant</th>
              <th className="py-4 px-6 text-[13px] font-semibold text-mdb-mint uppercase tracking-wider">Type</th>
              <th className="py-4 px-6 text-[13px] font-semibold text-mdb-mint uppercase tracking-wider">Amount</th>
              <th className="py-4 px-6 text-[13px] font-semibold text-mdb-mint uppercase tracking-wider">Status</th>
              <th className="py-4 px-6 text-[13px] font-semibold text-mdb-mint uppercase tracking-wider text-right">
                Assigned to Agent
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-mdb-border">
            {claims.map((claim) => {
              const { Icon, tile, icon } = claimIconForType(claim.claimType);
              const side = sideFor(claim.key);
              const isAgentic = side === 'agentic';

              return (
                <tr
                  key={claim.key}
                  className="group hover:bg-mdb-forest/15 transition-colors"
                >
                  <td className="py-4 px-6">
                    <div className="inline-flex items-center gap-3">
                      <span
                        className={`inline-flex items-center justify-center size-10 rounded-xl border ${tile}`}
                        aria-hidden="true"
                      >
                        <Icon className={`size-5 ${icon}`} strokeWidth={2} />
                      </span>
                      <span className="font-mono text-sm text-mdb-fog font-semibold tracking-tight">
                        {claim.id}
                      </span>
                    </div>
                  </td>
                  <td className="py-4 px-6">
                    <span className="text-sm text-mdb-fog font-medium">{claim.claimantName}</span>
                  </td>
                  <td className="py-4 px-6">
                    <span className="text-sm text-mdb-slate">{claim.claimType}</span>
                  </td>
                  <td className="py-4 px-6">
                    <span className="text-sm font-mono text-mdb-mint">
                      ${claim.claimAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </span>
                  </td>
                  <td className="py-4 px-6">
                    <div className="flex items-center gap-1.5">
                      {claim.status === 'INTAKE' && <Clock className="size-4 text-mdb-leaf" />}
                      {claim.status === 'PROCESSING' && <Activity className="size-4 text-amber-400" />}
                      {claim.status === 'RESOLVED' && <CheckCircle className="size-4 text-mdb-leaf" />}
                      <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-mdb-spruce text-mdb-mint border border-mdb-border">
                        {claim.status}
                      </span>
                    </div>
                  </td>
                  <td className="py-4 px-6 text-right">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={isAgentic}
                      onClick={() => handleToggleAssign(claim.key)}
                      onKeyDown={(event) => handleToggleKeyDown(event, claim.key)}
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
                      className="inline-flex items-center rounded-full p-0.5
                        bg-mdb-black border border-mdb-border
                        hover:border-mdb-leaf/40
                        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mdb-leaf focus-visible:ring-offset-2 focus-visible:ring-offset-mdb-black
                        transition-colors"
                    >
                      <span
                        className={`inline-flex items-center justify-center size-8 rounded-full transition-all ${
                          !isAgentic
                            ? 'bg-mdb-elevated text-mdb-fog shadow-sm'
                            : 'text-mdb-slate'
                        }`}
                        aria-hidden="true"
                      >
                        <UserRound className="size-3.5" strokeWidth={2.25} />
                      </span>
                      <span
                        className={`inline-flex items-center justify-center size-8 rounded-full transition-all ${
                          isAgentic
                            ? 'bg-mdb-leaf text-mdb-black shadow-[0_0_12px_rgba(0,237,100,0.35)]'
                            : 'text-mdb-slate'
                        }`}
                        aria-hidden="true"
                      >
                        <Bot className="size-3.5" strokeWidth={2.25} />
                      </span>
                    </button>
                  </td>
                </tr>
              );
            })}
            {claims.length === 0 && (
              <tr>
                <td colSpan={6} className="py-12 text-center text-sm text-mdb-slate">
                  No claims available.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
