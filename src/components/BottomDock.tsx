import React from 'react';
import {
  Columns2,
  Columns3,
  Database,
  Maximize2,
  PhoneOff,
  Play,
  RotateCcw,
  ShieldAlert,
  CheckCircle2,
  type LucideIcon,
} from 'lucide-react';
import { Claim } from '../types';
import { MongoLeaf } from './MongoLeaf';

export type LayoutWidth = 'comfortable' | 'wide' | 'stretch';

const LAYOUT_WIDTH_OPTIONS: {
  id: LayoutWidth;
  label: string;
  title: string;
  Icon: LucideIcon;
}[] = [
  { id: 'comfortable', label: 'Comfort', title: 'Comfortable width — more side margin', Icon: Columns2 },
  { id: 'wide', label: 'Wide', title: 'Wide layout — less side gap', Icon: Columns3 },
  { id: 'stretch', label: 'Stretch', title: 'Stretch to fill the screen', Icon: Maximize2 },
];

interface BottomDockProps {
  page: 'home' | 'mongo';
  claim: Claim | null;
  layoutWidth: LayoutWidth;
  loading: boolean;
  claimResolved: boolean;
  awaitingApproval: boolean;
  isWaitingOnReply: boolean;
  onLayoutWidth: (next: LayoutWidth) => void;
  onGoHome: () => void;
  onGoMongo: () => void;
  onReset: () => void;
  onStopWorkflow: () => void;
  onRunStep: () => void;
  onReviewSignoff: () => void;
}

export const BottomDock: React.FC<BottomDockProps> = ({
  page,
  claim,
  layoutWidth,
  loading,
  claimResolved,
  awaitingApproval,
  isWaitingOnReply,
  onLayoutWidth,
  onGoHome,
  onGoMongo,
  onReset,
  onStopWorkflow,
  onRunStep,
  onReviewSignoff,
}) => {
  const stepClass = loading
    ? 'agent-dock-item'
    : claimResolved
      ? 'agent-dock-item'
      : awaitingApproval || isWaitingOnReply
        ? 'agent-dock-item is-warn'
        : 'agent-dock-item is-cta';

  const stepLabel = loading
    ? 'Wait'
    : claimResolved
      ? 'Done'
      : awaitingApproval
        ? 'Sign-off'
        : 'Step';

  return (
    <nav className="agent-dock" aria-label="App controls">
      <div className="agent-dock-inner no-scrollbar">
        <span className="agent-dock-mark" title="Conquer" aria-hidden="true">
          <MongoLeaf className="size-5" />
        </span>

        <div className="inline-flex items-stretch" role="group" aria-label="Layout width">
          {LAYOUT_WIDTH_OPTIONS.map(opt => {
            const Icon = opt.Icon;
            const active = opt.id === layoutWidth;
            return (
              <button
                key={opt.id}
                type="button"
                className={`agent-dock-item ${active ? 'is-active' : ''}`}
                onClick={() => onLayoutWidth(opt.id)}
                title={opt.title}
                aria-label={opt.title}
                aria-pressed={active}
              >
                <Icon className="size-5" strokeWidth={2} />
                <span>{opt.label}</span>
              </button>
            );
          })}
        </div>

        <div className="agent-dock-divider" aria-hidden />

        <button
          type="button"
          className={`agent-dock-item ${page === 'mongo' ? 'is-active' : ''}`}
          onClick={() => (page === 'mongo' ? onGoHome() : onGoMongo())}
          title={page === 'mongo' ? 'Back to claims' : 'Open MongoDB CLI and state'}
          aria-label={page === 'mongo' ? 'Back to claims' : 'Open MongoDB page'}
          aria-pressed={page === 'mongo'}
        >
          <Database className="size-5" strokeWidth={2} />
          <span>{page === 'mongo' ? 'Claims' : 'MongoDB'}</span>
        </button>

        <button
          type="button"
          className="agent-dock-item"
          onClick={onReset}
          title="Wipe the database and start over"
          aria-label="Reset database"
        >
          <RotateCcw className="size-5" strokeWidth={2} />
          <span>Reset</span>
        </button>

        {page === 'home' && claim && (
          <>
            <div className="agent-dock-divider" aria-hidden />

            <button
              type="button"
              className="agent-dock-item is-danger"
              onClick={onStopWorkflow}
              disabled={loading}
              title="Disconnect — stop waiting on calls/SMS and close this claim interaction"
              aria-label="End workflow"
            >
              <PhoneOff className="size-5" strokeWidth={2} />
              <span>End</span>
            </button>

            <button
              type="button"
              className={stepClass}
              onClick={awaitingApproval ? onReviewSignoff : onRunStep}
              disabled={loading || claimResolved}
              title={
                awaitingApproval
                  ? 'This claim is held for adjuster sign-off — jump to the approval panel.'
                  : isWaitingOnReply
                    ? 'Demo/test override: skips the real wait for the inbound reply and advances the claim anyway.'
                    : 'Execute the next agent step'
              }
              aria-label={
                loading
                  ? 'Processing'
                  : claimResolved
                    ? 'Resolved'
                    : awaitingApproval
                      ? 'Review sign-off'
                      : 'Execute step'
              }
            >
              {loading ? (
                <span className="size-5 border-2 border-current/30 border-t-current rounded-full animate-spin" />
              ) : claimResolved ? (
                <CheckCircle2 className="size-5" strokeWidth={2} />
              ) : awaitingApproval ? (
                <ShieldAlert className="size-5" strokeWidth={2} />
              ) : (
                <Play className="size-5" strokeWidth={2} />
              )}
              <span>{stepLabel}</span>
            </button>
          </>
        )}
      </div>
    </nav>
  );
};
