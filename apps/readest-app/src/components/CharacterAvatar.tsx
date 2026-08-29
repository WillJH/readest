'use client';

import clsx from 'clsx';
import React from 'react';

interface CharacterAvatarProps {
  name: string;
  /** Blob URL of the character's image; falls back to an initial chip. */
  url?: string;
  size?: number;
  className?: string;
}

/** Stable hue from the name, so the fallback chip never changes color. */
function hueFromName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) % 100000;
  }
  return hash % 360;
}

/**
 * Round character avatar: the image when the character has one, otherwise a
 * colored initial chip. Used by the chat identity UI and the presence entry.
 */
const CharacterAvatar: React.FC<CharacterAvatarProps> = ({ name, url, size = 36, className }) => {
  const style = { width: size, height: size };
  if (url) {
    return (
      <img
        src={url}
        alt={name}
        style={style}
        className={clsx('bg-base-300/60 shrink-0 rounded-full object-cover', className)}
      />
    );
  }
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  return (
    <span
      aria-hidden='true'
      style={{ ...style, backgroundColor: `hsl(${hueFromName(name)} 42% 45%)` }}
      className={clsx(
        'text-primary-content flex shrink-0 items-center justify-center rounded-full font-semibold',
        className,
      )}
    >
      <span style={{ fontSize: Math.round(size * 0.42) }}>{initial}</span>
    </span>
  );
};

export default CharacterAvatar;
