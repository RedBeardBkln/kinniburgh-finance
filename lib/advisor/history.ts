// Replay of stored conversation history to the model (plan sections 6 and 9). PURE.
//
// History is replayed as TEXT only (the stored user and assistant text); a follow-up that needs fresh numbers calls the tools again.
// Oldest messages are dropped first, and a marker tells the model that earlier messages were omitted. The result always starts with a
// user turn and alternates roles (the API requires it).

export interface StoredTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ReplayMessage {
  role: "user" | "assistant";
  content: string;
}

export const OMITTED_MARKER = "[Earlier messages in this conversation were omitted to keep the conversation short.]";

export interface ReplayOptions {
  maxMessages: number;
  maxChars: number;
}

export function buildReplay(history: readonly StoredTurn[], opts: ReplayOptions): ReplayMessage[] {
  // Drop empty turns (an aborted turn may have stored nothing) before measuring.
  const turns = history.filter((m) => m.text.trim() !== "");
  const kept: StoredTurn[] = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const m = turns[i]!;
    if (kept.length >= opts.maxMessages || (kept.length > 0 && chars + m.text.length > opts.maxChars)) break;
    kept.push(m);
    chars += m.text.length;
  }
  kept.reverse();
  const omitted = kept.length < turns.length;
  // Must start with a user turn.
  while (kept.length > 0 && kept[0]!.role !== "user") kept.shift();

  // Merge consecutive same-role turns (can happen after a failed turn) so roles alternate.
  const merged: ReplayMessage[] = [];
  for (const m of kept) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.role === m.role) last.content = `${last.content}\n\n${m.text}`;
    else merged.push({ role: m.role, content: m.text });
  }
  if (omitted && merged.length > 0 && merged[0]!.role === "user") {
    merged[0] = { role: "user", content: `${OMITTED_MARKER}\n\n${merged[0]!.content}` };
  }
  return merged;
}
