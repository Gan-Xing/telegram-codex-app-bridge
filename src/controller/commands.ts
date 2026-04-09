export interface ParsedCommand {
  name: string;
  args: string[];
  targetBot: string | null;
}

export function parseCommand(text: string): ParsedCommand | null {
  if (!text.startsWith('/')) return null;
  const parts = text.trim().split(/\s+/);
  const rawName = parts.shift();
  if (!rawName) return null;
  const [namePart, targetPart] = rawName.slice(1).split('@', 2);
  const name = (namePart ?? '').toLowerCase();
  if (!name) return null;
  return {
    name,
    args: parts,
    targetBot: targetPart ? targetPart.toLowerCase() : null,
  };
}
