// Shared building blocks of the printable report sheets (server components, no client JavaScript).
import type { ReactNode } from "react";
import { INK_MUTED, OVER } from "@/components/reports/report-charts";

export function Stat({ label, value, sub, alert = false }: { label: string; value: string; sub: string; alert?: boolean }) {
  return (
    <div className="rounded-md border border-[#e7e6e2] px-2.5 py-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-[#6b6a66]">{label}</p>
      <p className="text-lg font-bold leading-tight tabular-nums" style={alert ? { color: OVER } : undefined}>
        {alert && <span aria-hidden="true">▲ </span>}
        {value}
      </p>
      <p className="text-[10px] leading-tight" style={{ color: INK_MUTED }}>
        {sub}
      </p>
    </div>
  );
}

export function Panel({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div className="avoid-break rounded-md border border-[#e7e6e2] p-2.5">
      <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wide">{title}</h3>
      {children}
      {note && <p className="mt-1 text-[9.5px] leading-snug text-[#6b6a66]">{note}</p>}
    </div>
  );
}
