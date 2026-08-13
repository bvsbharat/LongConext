import React, { useState } from 'react';
import { defaultDoodleIndex, defaultSceneIndex, doodleSrc, sceneSrc } from '../lib/doodles';

interface ClaimCardArtProps {
  claimKey: string;
  claimantName: string;
  claimType: string;
  /** Full-bleed thumbnail art vs compact table-row identity. */
  variant?: 'hero' | 'row';
}

export function ClaimCardArt({
  claimKey,
  claimantName,
  claimType,
  variant = 'hero',
}: ClaimCardArtProps) {
  const [sceneFailed, setSceneFailed] = useState(false);
  const [faceFailed, setFaceFailed] = useState(false);

  const sceneUrl = sceneSrc(defaultSceneIndex(claimType, claimKey));
  const faceUrl = doodleSrc(defaultDoodleIndex(claimantName));
  const isRow = variant === 'row';

  const scene = sceneFailed ? (
    <span className="claim-card-art-emoji" aria-hidden>📋</span>
  ) : (
    <img
      src={sceneUrl}
      alt=""
      aria-hidden
      onError={() => setSceneFailed(true)}
      className="claim-card-art-img"
    />
  );

  const face = faceFailed ? (
    <span className="claim-card-art-emoji" aria-hidden>👤</span>
  ) : (
    <img
      src={faceUrl}
      alt=""
      aria-hidden
      onError={() => setFaceFailed(true)}
      className={`claim-card-art-img ${isRow ? '' : 'claim-card-art-img-flip'}`}
    />
  );

  if (isRow) {
    return (
      <span
        className="claim-identity"
        role="img"
        aria-label={`${claimantName} — ${claimType}`}
      >
        <span className="claim-identity-scene">{scene}</span>
        <span className="claim-identity-face">{face}</span>
      </span>
    );
  }

  return (
    <div
      className="claim-card-art"
      role="img"
      aria-label={`${claimantName} — ${claimType}`}
    >
      <span className="claim-card-art-scene">{scene}</span>
      <span className="claim-card-art-face">{face}</span>
    </div>
  );
}
