const AVATAR_TAG_RE = /^\s*\[avatar:\s*([^\]]+?)\s*\]/;

export interface ParsedAvatarMessage {
  /** The label the model picked, or null when the reply has no tag. */
  label: string | null;
  /** The reply with the leading tag (and its trailing whitespace) removed. */
  displayText: string;
}

/**
 * Split a leading `[avatar: name]` tag off an assistant reply. The tag is
 * stored with the message (so history replays keep their avatars) and only
 * stripped here, at render time.
 */
export function parseAvatarTag(text: string): ParsedAvatarMessage {
  const match = AVATAR_TAG_RE.exec(text);
  if (!match) return { label: null, displayText: text };
  return { label: match[1]!, displayText: text.slice(match[0].length).replace(/^\s+/, '') };
}
