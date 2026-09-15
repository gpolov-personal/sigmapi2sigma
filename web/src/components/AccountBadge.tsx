import { User } from "lucide-react";

// Small pill(s) showing which Claude account(s) a session belongs to.
//
// The person glyph is load-bearing: single-letter account names ("W", "P") sit next to
// tmux window/pane counts ("2w · 2p") in the Snapshots and Tmux Map rows, and a bare
// letter reads as another count. The icon says "this is a who, not a how many".
//
// FNV-1a rather than a simple polynomial hash: the old `h * 31 + c` mapped one-character
// names onto near-identical hues (P→80, W→87, both the same green), which defeated the
// point of colouring them at all. FNV's avalanche pulls them apart (P→81, W→258).
function hue(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 360;
}

export function AccountBadge({ accounts }: { accounts: string[] }) {
  if (!accounts || accounts.length === 0) return null;
  return (
    <span className="inline-flex gap-1">
      {accounts.map(a => (
        <span key={a}
          className="text-[10px] px-1.5 py-0.5 rounded font-medium inline-flex items-center gap-0.5"
          style={{ backgroundColor: `hsl(${hue(a)} 40% 25%)`, color: `hsl(${hue(a)} 80% 80%)` }}
          title={`Claude account: ${a} (not a tmux window or pane)`}
        >
          <User size={9} strokeWidth={2.5} aria-hidden />
          {a}
        </span>
      ))}
    </span>
  );
}
