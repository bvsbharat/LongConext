import React from 'react';

/** Simplified MongoDB leaf mark — used in the bottom command dock. */
export const MongoLeaf: React.FC<{ className?: string; title?: string }> = ({
  className = 'size-4',
  title,
}) => (
  <svg
    viewBox="0 0 32 32"
    className={className}
    aria-hidden={title ? undefined : true}
    role={title ? 'img' : 'presentation'}
  >
    {title ? <title>{title}</title> : null}
    <path
      fill="#00ED64"
      d="M16.4 2.1c.4-.5 1.1-.4 1.4.2 2.6 4.6 8.4 13.4 8.4 19.2 0 5.4-3.9 8.7-9.6 8.7-5.8 0-9.6-3.3-9.6-8.7 0-5.8 5.8-14.6 8.4-19.2.2-.4.6-.5 1-.2z"
    />
    <path
      fill="#001E2B"
      d="M16.7 29.8c.1-7.6.6-14.2.6-21.9 0-.4-.4-.6-.7-.4-1.6 1.3-3 4.2-3.6 6.6-.2.7.4 1.3 1.1 1.2 1.6-.2 2.4.6 2.6 14.5z"
    />
  </svg>
);
