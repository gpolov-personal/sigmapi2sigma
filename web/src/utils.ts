export function relativeTime(ms: number): string {
  const d = Date.now() - ms;
  if (d < 0) return "in the future";
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

export async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); } catch {}
}

export function trunc(s: string | null | undefined, n = 120): string {
  if (!s) return "";
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? oneLine.slice(0, n) + "…" : oneLine;
}

// Compute a project abbreviation from its name. Used as the prefix in compound chips.
// Rules:
//   - Tokens are split on whitespace; alpha and numeric tokens are categorized.
//   - 1 alpha token → up to 6 letters (capitalized first).
//   - ≥2 alpha tokens → pick the 2 longest, give each 3 letters, drop the rest.
//   - Numeric tokens are preserved fully and remain in their original positions.
//
// Examples:
//   AgenticAI                 → "Agenti"
//   The Investor Presentation → "InvPre"
//   Project Test 2            → "ProTes2"
//   Project 2 Test 37         → "Pro2Tes37"
//   Math                      → "Math"
export function computeProjectAbbreviation(name: string): string {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";

  const alphaTokens = tokens.filter(t => /[A-Za-z]/.test(t));
  if (alphaTokens.length === 0) return tokens.join("");

  // Pick which alpha tokens get included and how many letters each.
  const charsPerToken = alphaTokens.length === 1 ? 6 : 3;
  let chosen: Set<string>;
  if (alphaTokens.length === 1) {
    chosen = new Set([alphaTokens[0]]);
  } else {
    // Sort by length desc, take top 2 (stable enough for our needs).
    const sorted = [...alphaTokens].sort((a, b) => b.length - a.length);
    chosen = new Set([sorted[0], sorted[1]].filter(Boolean) as string[]);
  }

  let out = "";
  for (const t of tokens) {
    if (/^\d+$/.test(t)) {
      out += t;
    } else if (chosen.has(t)) {
      const slice = t.slice(0, charsPerToken);
      out += slice.charAt(0).toUpperCase() + slice.slice(1).toLowerCase();
    }
  }
  return out || tokens[0].slice(0, 6);
}

export function projectAbbreviation(project: { name: string; abbreviation: string | null }): string {
  if (project.abbreviation && project.abbreviation.trim().length > 0) return project.abbreviation;
  return computeProjectAbbreviation(project.name);
}

// Format a duration in minutes as "Xm" / "Xh Ym" / "Xd Yh".
// 1 day = workdayHours * 60 minutes (default 8h workday).
// Sub-minute non-zero values render as "0.Ym" (one decimal) so small splits don't disappear.
export function formatDuration(minutes: number, workdayHours: number): string {
  const m = Math.max(0, minutes);
  if (m === 0) return "0m";
  if (m < 1) return `${m.toFixed(1)}m`;
  const dayMin = workdayHours * 60;
  if (m < 60) return `${Math.round(m)}m`;
  if (m < dayMin) {
    const h = Math.floor(m / 60);
    const r = Math.round(m - h * 60);
    return r === 0 ? `${h}h` : `${h}h ${r}m`;
  }
  const d = Math.floor(m / dayMin);
  const remH = Math.floor((m - d * dayMin) / 60);
  return remH === 0 ? `${d}d` : `${d}d ${remH}h`;
}
