// Small pill(s) showing which Claude account(s) a session belongs to.
// A deterministic hue per name keeps P/W visually stable.
function hue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

export function AccountBadge({ accounts }: { accounts: string[] }) {
  if (!accounts || accounts.length === 0) return null;
  return (
    <span className="inline-flex gap-1">
      {accounts.map(a => (
        <span key={a}
          className="text-[10px] px-1.5 py-0.5 rounded font-medium"
          style={{ backgroundColor: `hsl(${hue(a)} 40% 25%)`, color: `hsl(${hue(a)} 80% 80%)` }}
          title={`Claude account: ${a}`}
        >{a}</span>
      ))}
    </span>
  );
}
