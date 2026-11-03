// Small server-rendered SVG charts for the printable Personal reports. No client JavaScript: they print exactly as
// they render. The sheet is always a white "paper" page (screen and print), so the colours are the light-surface steps
// of the reference palette: blue for spending, the reserved critical red only for "over budget" (always with a text
// label beside it, never colour alone), recessive grays for tracks and grid. Each mark carries a <title> so hovering
// shows its value on screen.
import { centsText } from "@/lib/dashboard-drill";
import type { CategoryBar, WeekBucket } from "@/lib/personal-reports";

export const INK = "#1f1f1d";
export const INK_MUTED = "#6b6a66";
export const TRACK = "#e7e6e2";
export const GRID = "#d6d5d0";
export const SPEND = "#2a78d6";
export const SPEND_LIGHT = "#9ec5f4";
export const SECOND = "#eb6834";
export const OVER = "#d03b3b";
export const GOOD = "#0ca30c";

export function whole(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${Math.round(Math.abs(cents) / 100).toLocaleString("en-US")}`;
}

/** Ring showing the share of the budget used, with the month's share gone as a tick on the same ring. */
export function BudgetRing({ usedPct, elapsedPct, size = 132 }: { usedPct: number | null; elapsedPct: number; size?: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const used = Math.max(0, usedPct ?? 0);
  const over = used > 100;
  const fill = Math.min(used, 100) / 100;
  const tickAngle = (elapsedPct / 100) * 2 * Math.PI - Math.PI / 2;
  const tx1 = 60 + Math.cos(tickAngle) * (r - 11);
  const ty1 = 60 + Math.sin(tickAngle) * (r - 11);
  const tx2 = 60 + Math.cos(tickAngle) * (r + 11);
  const ty2 = 60 + Math.sin(tickAngle) * (r + 11);
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} role="img" aria-label={`${usedPct ?? 0}% of the budget used, ${elapsedPct}% of the month gone`}>
      <circle cx="60" cy="60" r={r} fill="none" stroke={TRACK} strokeWidth="14" />
      <circle
        cx="60"
        cy="60"
        r={r}
        fill="none"
        stroke={over ? OVER : SPEND}
        strokeWidth="14"
        strokeDasharray={`${fill * c} ${c}`}
        transform="rotate(-90 60 60)"
      >
        <title>{`${usedPct ?? 0}% of the budget used`}</title>
      </circle>
      <line x1={tx1} y1={ty1} x2={tx2} y2={ty2} stroke={INK} strokeWidth="2.5" strokeLinecap="round">
        <title>{`${elapsedPct}% of the month gone`}</title>
      </line>
      <text x="60" y="58" textAnchor="middle" fontSize="22" fontWeight="700" fill={INK}>
        {usedPct === null ? "—" : `${usedPct}%`}
      </text>
      <text x="60" y="74" textAnchor="middle" fontSize="9" fill={INK_MUTED}>
        of budget used
      </text>
    </svg>
  );
}

/** One square per day of the month: gone (filled), today (outlined), still to come (empty). */
export function MonthCalendar({ dayOfMonth, daysInMonth, firstWeekday }: { dayOfMonth: number; daysInMonth: number; firstWeekday: number }) {
  const cell = 15;
  const gap = 3;
  const cells = [];
  const rows = Math.ceil((firstWeekday + daysInMonth) / 7);
  for (let d = 1; d <= daysInMonth; d += 1) {
    const idx = firstWeekday + d - 1;
    const x = (idx % 7) * (cell + gap);
    const y = 12 + Math.floor(idx / 7) * (cell + gap);
    const past = d < dayOfMonth;
    const today = d === dayOfMonth;
    cells.push(
      <g key={d}>
        <rect
          x={x + 1}
          y={y + 1}
          width={cell - 2}
          height={cell - 2}
          rx="3"
          fill={past ? SPEND_LIGHT : today ? SPEND : "#ffffff"}
          stroke={past || today ? "none" : GRID}
          strokeWidth="1"
        >
          <title>{today ? `Day ${d}: today` : past ? `Day ${d}: gone` : `Day ${d}: still to come`}</title>
        </rect>
        <text x={x + cell / 2} y={y + cell / 2 + 3} textAnchor="middle" fontSize="7" fill={today ? "#ffffff" : INK_MUTED}>
          {d}
        </text>
      </g>
    );
  }
  const w = 7 * (cell + gap);
  return (
    <svg viewBox={`0 0 ${w} ${12 + rows * (cell + gap)}`} width={w} role="img" aria-label={`Day ${dayOfMonth} of ${daysInMonth}`}>
      {["S", "M", "T", "W", "T", "F", "S"].map((l, i) => (
        <text key={i} x={i * (cell + gap) + cell / 2} y="8" textAnchor="middle" fontSize="7" fill={INK_MUTED}>
          {l}
        </text>
      ))}
      {cells}
    </svg>
  );
}

/** Spending per week of the month, with each week's even share of the monthly budget as a dashed reference. */
export function WeekBars({ weeks, budgetCents, daysInMonth }: { weeks: WeekBucket[]; budgetCents: number; daysInMonth: number }) {
  const W = 480;
  const H = 132;
  const top = 18;
  const bottom = 30;
  const plotH = H - top - bottom;
  const evenFor = (w: WeekBucket) => Math.round((budgetCents * (w.toDay - w.fromDay + 1)) / daysInMonth);
  const max = Math.max(1, ...weeks.map((w) => Math.max(w.spentCents, evenFor(w))));
  const slot = W / weeks.length;
  const barW = Math.min(44, slot - 16);
  const y = (cents: number) => top + plotH - (Math.max(0, cents) / max) * plotH;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Spending by week of the month">
      <line x1="0" x2={W} y1={top + plotH} y2={top + plotH} stroke={GRID} strokeWidth="1" />
      {weeks.map((w, i) => {
        const cx = slot * i + slot / 2;
        const even = evenFor(w);
        const h = top + plotH - y(w.spentCents);
        return (
          <g key={w.label}>
            {w.future ? (
              <rect x={cx - barW / 2} y={top + plotH - 4} width={barW} height="4" rx="2" fill={TRACK}>
                <title>{`${w.label}: still to come`}</title>
              </rect>
            ) : (
              <path
                d={roundedTopBar(cx - barW / 2, y(w.spentCents), barW, h)}
                fill={w.current ? SPEND : SPEND_LIGHT}
              >
                <title>{`${w.label}: ${centsText(w.spentCents)} spent (even share of the budget ${centsText(even)})`}</title>
              </path>
            )}
            {budgetCents > 0 && (
              <line x1={cx - barW / 2 - 5} x2={cx + barW / 2 + 5} y1={y(even)} y2={y(even)} stroke={INK} strokeWidth="1.5" strokeDasharray="3 2">
                <title>{`Even share of the monthly budget for ${w.label}: ${centsText(even)}`}</title>
              </line>
            )}
            {!w.future && (
              <text x={cx} y={y(Math.max(w.spentCents, 0)) - 4} textAnchor="middle" fontSize="10" fontWeight={w.current ? 700 : 500} fill={INK}>
                {whole(w.spentCents)}
              </text>
            )}
            <text x={cx} y={H - 16} textAnchor="middle" fontSize="9" fill={INK_MUTED}>
              {w.label}
            </text>
            {w.current && (
              <text x={cx} y={H - 5} textAnchor="middle" fontSize="8" fontWeight="700" fill={INK}>
                this week
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function roundedTopBar(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return `M${x},${y} h${w} v0 h${-w} Z`;
  const r = Math.min(4, h, w / 2);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

/**
 * One bullet row per budget category: the track is the budget, the fill what was spent (in % of its own budget, up to
 * 150%), and the black tick where spending would be on an even pace today. Over budget fills red and says "over".
 */
export function CategoryBullets({ bars, elapsedPct }: { bars: CategoryBar[]; elapsedPct: number }) {
  const rowH = 19;
  const labelW = 170;
  const valueW = 170;
  const W = 840;
  const trackW = W - labelW - valueW - 8;
  const scaleMax = 150;
  const xOf = (p: number) => labelW + (Math.min(p, scaleMax) / scaleMax) * trackW;
  const H = bars.length * rowH + 14;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Spending against budget by category">
      {/* 100% marker */}
      <line x1={xOf(100)} x2={xOf(100)} y1="0" y2={H - 12} stroke={GRID} strokeWidth="1" />
      <text x={xOf(100)} y={H - 2} textAnchor="middle" fontSize="8" fill={INK_MUTED}>
        budget
      </text>
      {bars.map((b, i) => {
        const y = i * rowH + 3;
        // No budget (money outside every line): no bar, only the amount, so it never reads as "far over".
        const p = b.budgetCents > 0 ? (b.spentCents / b.budgetCents) * 100 : 0;
        const fillW = Math.max(0, xOf(Math.max(p, 0)) - labelW);
        const color = b.over ? OVER : SPEND;
        return (
          <g key={b.key}>
            <text x={labelW - 6} y={y + 11} textAnchor="end" fontSize="11" fill={b.folded ? INK_MUTED : INK} fontStyle={b.folded ? "italic" : "normal"}>
              {truncate(b.name, 22)}
            </text>
            {b.budgetCents > 0 && <rect x={labelW} y={y + 3} width={xOf(100) - labelW} height="11" rx="2" fill={TRACK} />}
            {fillW > 0 && (
              <rect x={labelW} y={y + 5} width={fillW} height="7" rx="2" fill={color}>
                <title>{`${b.name}: ${centsText(b.spentCents)} of ${centsText(b.budgetCents)}`}</title>
              </rect>
            )}
            {p > scaleMax && <path d={`M${xOf(scaleMax) + 1},${y + 3} l6,5.5 l-6,5.5 Z`} fill={OVER} />}
            {b.budgetCents > 0 && elapsedPct < 100 && (
              <line x1={xOf(elapsedPct)} x2={xOf(elapsedPct)} y1={y + 1} y2={y + 16} stroke={INK} strokeWidth="1.5" />
            )}
            <text x={W - valueW + 6} y={y + 11} fontSize="11" fill={INK}>
              <tspan fontWeight="600">{whole(b.spentCents)}</tspan>
              <tspan fill={INK_MUTED}>{b.budgetCents > 0 ? ` of ${whole(b.budgetCents)}` : " (no budget line)"}</tspan>
              {b.over && b.budgetCents > 0 && (
                <tspan fill={OVER} fontWeight="700">
                  {" "}
                  over
                </tspan>
              )}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Fixed vs variable spending as one stacked bar, labelled directly. */
export function SplitBar({ fixedCents, variableCents }: { fixedCents: number; variableCents: number }) {
  const total = Math.max(1, Math.max(0, fixedCents) + Math.max(0, variableCents));
  const W = 300;
  const fW = (Math.max(0, fixedCents) / total) * W;
  const vW = W - fW;
  const gap = fW > 0 && vW > 0 ? 2 : 0;
  return (
    <svg viewBox={`0 0 ${W} 40`} width="100%" role="img" aria-label="Fixed and variable spending">
      {fW > 0 && (
        <rect x="0" y="4" width={Math.max(0, fW - gap / 2)} height="14" rx="3" fill={SPEND}>
          <title>{`Fixed: ${centsText(fixedCents)}`}</title>
        </rect>
      )}
      {vW > 0 && (
        <rect x={fW + gap / 2} y="4" width={Math.max(0, vW - gap / 2)} height="14" rx="3" fill={SECOND}>
          <title>{`Variable: ${centsText(variableCents)}`}</title>
        </rect>
      )}
      <rect x="0" y="27" width="8" height="8" rx="2" fill={SPEND} />
      <text x="12" y="35" fontSize="9.5" fill={INK}>
        Fixed {whole(fixedCents)} ({Math.round((Math.max(0, fixedCents) / total) * 100)}%)
      </text>
      <rect x={W / 2 + 10} y="27" width="8" height="8" rx="2" fill={SECOND} />
      <text x={W / 2 + 22} y="35" fontSize="9.5" fill={INK}>
        Variable {whole(variableCents)} ({Math.round((Math.max(0, variableCents) / total) * 100)}%)
      </text>
    </svg>
  );
}

/** Thin progress meter for the month-end table (share of the line's budget used; red past 100%). */
export function UsedMeter({ usedPct, over }: { usedPct: number | null; over: boolean }) {
  if (usedPct === null) return null;
  const p = Math.max(0, Math.min(usedPct, 100));
  return (
    <svg viewBox="0 0 40 6" width="40" height="6" aria-hidden="true">
      <rect x="0" y="0" width="40" height="6" rx="2" fill={TRACK} />
      {p > 0 && <rect x="0" y="0" width={(p / 100) * 40} height="6" rx="2" fill={over ? OVER : SPEND} />}
    </svg>
  );
}
