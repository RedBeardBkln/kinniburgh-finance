import Link from "next/link";
import type { Route } from "next";
import {
  SHEET_CHIP_LABELS,
  SHEET_STATUS_LABELS,
  overrideNote,
  type SheetAlternative,
  type SheetChip,
  type SheetChipKind,
  type SheetDecision,
  type SheetFormGroup,
  type SheetHeadlineRow,
  type SheetLine,
  type SheetModel,
  type SheetOpenItem,
  type SheetStatus,
} from "@/lib/tax2025-sheet";
import { OverrideDecisionButton } from "@/components/tax/forms/override-decision-button";
import { OverrideLineButton } from "@/components/tax/forms/override-line-button";
import { OverridesPanel } from "@/components/tax/forms/overrides-panel";

// The printable CPA REVIEW SHEET (Phase 1c). A server component: it receives ONLY the
// plain-JSON SheetModel (built from the engine's Ty2025Return) - no Decimals, no raw
// extraction data. Six parts, each starting a new printed page (see the #return-sheet
// block in app/globals.css):
//   P1 summary   P2 federal lines   P3 Connecticut lines
//   P4 CPA decisions   P5 open items, conflicts, owner homework   P6 documents + sign-off
// Everything here is a computed DRAFT; the CPA is the preparer of record. A line without
// an amount says "not computed" - it is never printed as 0.

const STATUS_CLASS: Readonly<Record<SheetStatus, string>> = {
  computed: "border-green-300 bg-green-50 text-green-800",
  not_applicable: "border-border bg-muted text-muted-foreground",
  informational: "border-border bg-muted text-muted-foreground",
  missing_input: "border-red-300 bg-red-50 text-red-800",
  not_yet_computed: "border-amber-300 bg-amber-50 text-amber-900",
  needs_cpa_rule_unverified: "border-violet-300 bg-violet-50 text-violet-800",
  needs_cpa_judgment: "border-violet-300 bg-violet-50 text-violet-800",
  overridden: "border-fuchsia-400 bg-fuchsia-50 text-fuchsia-900 font-semibold",
};

const CHIP_CLASS: Readonly<Record<SheetChipKind, string>> = {
  document_verified: "border-green-300 bg-green-50 text-green-800",
  document_unverified: "border-amber-400 bg-amber-50 text-amber-900",
  owner_answer: "border-blue-300 bg-blue-50 text-blue-800",
  books: "border-slate-300 bg-slate-50 text-slate-700",
  derived: "border-border bg-muted text-muted-foreground",
  paystub: "border-slate-300 bg-slate-50 text-slate-700",
  decision: "border-violet-300 bg-violet-50 text-violet-800",
  override: "border-fuchsia-400 bg-fuchsia-50 text-fuchsia-900",
};

function StatusBadge({ status, label }: { status: SheetStatus; label?: string }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${STATUS_CLASS[status]}`}>
      {label ?? SHEET_STATUS_LABELS[status]}
    </span>
  );
}

function Chip({ chip }: { chip: SheetChip }) {
  const cls = `inline-block rounded-full border px-1.5 py-0.5 text-[10px] leading-tight ${CHIP_CLASS[chip.kind]}`;
  const text = (
    <>
      <span className="font-medium">{SHEET_CHIP_LABELS[chip.kind]}</span>: {chip.label}
    </>
  );
  return chip.href !== null ? (
    <Link href={chip.href as Route} prefetch={false} className={`${cls} hover:underline`}>
      {text}
    </Link>
  ) : (
    <span className={cls}>{text}</span>
  );
}

function Draft({ label }: { label: string }) {
  return (
    <p className="rounded-md border-2 border-amber-500 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-950" data-testid="draft-label">
      {label}
    </p>
  );
}

// ── P1 ────────────────────────────────────────────────────────────────────────

function HeadlineTable({ title, rows, showProvisional }: { title: string; rows: SheetHeadlineRow[]; showProvisional: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[28rem] text-sm">
        <caption className="pb-1 text-left text-sm font-semibold">{title}</caption>
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-1 pr-3 font-medium">Item</th>
            <th className="py-1 pr-3 text-right font-medium">Computed by the app</th>
            <th className="py-1 pr-3 font-medium">Status</th>
            {showProvisional ? <th className="py-1 text-right font-medium">Provisional estimate</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b align-top">
              <td className="py-1 pr-3">{r.label}</td>
              <td className="py-1 pr-3 text-right tabular-nums font-medium">
                {r.computedText}
                {r.overridden ? (
                  <span className="block text-[11px] font-semibold text-fuchsia-900" data-testid="headline-overridden">
                    OVERRIDDEN line: {r.effectiveText !== null ? `figure with the override ${r.effectiveText}` : "see the override on the line"}
                  </span>
                ) : null}
                {r.dependsOnOverride ? (
                  <span className="block text-[11px] font-normal text-fuchsia-900" data-testid="headline-depends">
                    depends on an override; not recomputed
                  </span>
                ) : null}
              </td>
              <td className="py-1 pr-3">
                <StatusBadge status={r.status} />
              </td>
              {showProvisional ? (
                <td className="py-1 text-right tabular-nums text-muted-foreground">{r.provisionalText ?? "not estimated"}</td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Counter({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className={`rounded-md border px-3 py-2 ${warn && value > 0 ? "border-amber-300 bg-amber-50" : ""}`}>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}

function PartSummary({ model }: { model: SheetModel }) {
  const s = model.summary;
  return (
    <section id="part-1" className="sheet-part space-y-4" aria-labelledby="part-1-title">
      <Draft label={model.draftLabel} />
      <div>
        <h2 id="part-1-title" className="text-xl font-semibold">
          1. Summary - tax year {model.taxYear}, married filing jointly
        </h2>
        <p className="text-xs text-muted-foreground">
          Engine {model.engineVersion} - generated {model.generatedAtDisplay} (America/New_York). Computed from your answers,
          documents and books; every line below shows where its figure came from. Not tax advice; nothing here has been filed.
        </p>
      </div>
      <p
        className={`rounded-md border px-3 py-2 text-sm ${s.complete ? "border-green-300 bg-green-50 text-green-900" : "border-red-300 bg-red-50 text-red-900"}`}
        data-testid="completeness"
      >
        {s.completenessText}
      </p>
      <OverridesPanel summary={s.overrides} />
      <HeadlineTable title="Federal (Form 1040)" rows={s.federal} showProvisional={!s.complete} />
      <HeadlineTable title="Connecticut (CT-1040)" rows={s.connecticut} showProvisional={!s.complete} />
      {!s.complete && s.provisionalNote !== null ? (
        <div className="space-y-1 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          <p>{s.provisionalNote}</p>
          {s.provisionalAssumedFacts.length > 0 ? (
            <details>
              <summary className="cursor-pointer">Inputs treated as $0 / none in the provisional estimate ({s.provisionalAssumedFacts.length})</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {s.provisionalAssumedFacts.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Counter label="blocking items" value={s.blockingItemCount} warn />
        <Counter label="advisory items" value={s.advisoryItemCount} />
        <Counter label="unverified documents counted" value={s.unverifiedDocumentCount} warn />
        <Counter label="derived (inferred) inputs" value={s.derivedInputCount} warn />
        <Counter label="undecided CPA decisions" value={s.undecidedDecisionCount} warn />
      </div>
      {s.caveats.length > 0 ? (
        <div>
          <h3 className="text-sm font-semibold">Caveats</h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
            {s.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground" data-testid="status-counts">
        Lines on this sheet:{" "}
        {(Object.keys(s.statusCounts) as SheetStatus[])
          .filter((k) => s.statusCounts[k] > 0)
          .map((k) => `${s.statusCounts[k]} ${SHEET_STATUS_LABELS[k]}`)
          .join(", ")}
        .
      </p>
    </section>
  );
}

// ── P2 / P3 ───────────────────────────────────────────────────────────────────

function LineRow({ line, taxYear }: { line: SheetLine; taxYear: 2025 }) {
  const muted = line.status === "not_applicable" || line.status === "informational";
  const blocked = line.amount === null && !muted;
  const ov = line.override;
  return (
    <tr
      className={`border-b align-top ${muted ? "text-muted-foreground" : ""} ${blocked ? "bg-amber-50/40" : ""} ${ov !== null ? "bg-fuchsia-50/50" : ""}`}
      data-line-key={line.key}
    >
      <td className="whitespace-nowrap py-1 pr-2 text-xs tabular-nums">{line.formLine}</td>
      <td className="py-1 pr-2">
        {line.label}
        {ov !== null ? (
          <span className="mt-1 block rounded border border-violet-300 bg-violet-50 px-1.5 py-0.5 text-[11px] text-violet-900" data-testid="override-note">
            {overrideNote(ov)}
          </span>
        ) : null}
        {line.dependsOnOverridden.length > 0 ? (
          <span className="mt-1 block rounded border border-fuchsia-300 bg-fuchsia-50 px-1.5 py-0.5 text-[11px] text-fuchsia-900" data-testid="depends-on-override">
            depends on an override, not recomputed: {line.dependsOnOverridden.map((d) => d.text).join(", ")}
          </span>
        ) : null}
        {line.canOverride ? (
          <span className="mt-1 block">
            <OverrideLineButton
              taxYear={taxYear}
              line={{
                key: line.key,
                form: line.form,
                formLine: line.formLine,
                label: line.label,
                computed: line.computed,
                override:
                  ov === null
                    ? null
                    : { id: ov.id, version: ov.version, authority: ov.authority, nowAmount: ov.nowAmount, note: overrideNote(ov), reason: ov.reason, stale: ov.stale },
                affects: line.affects,
                affectsMore: line.affectsMore,
              }}
            />
          </span>
        ) : null}
      </td>
      <td className={`whitespace-nowrap py-1 pr-2 text-right tabular-nums ${line.amount === null ? "text-xs italic" : "font-medium"}`}>
        {line.amountText}
      </td>
      <td className="py-1 pr-2">
        <StatusBadge status={line.status} label={line.statusLabel} />
      </td>
      <td className="py-1 pr-2">
        <div className="flex flex-wrap gap-1">
          {line.chips.map((c, i) => (
            <Chip key={`${c.kind}-${c.label}-${i}`} chip={c} />
          ))}
        </div>
      </td>
      <td className="py-1 text-xs">
        {line.reason !== null ? <span>{line.reason}</span> : null}
        {line.citations.length > 0 ? (
          <span className="block text-[11px] text-muted-foreground">
            Sources:{" "}
            {line.citations.map((c, i) => (
              <span key={c.id}>
                {i > 0 ? ", " : ""}
                {c.url !== null ? (
                  <a href={c.url} target="_blank" rel="noreferrer" className="underline">
                    {c.id}
                  </a>
                ) : (
                  c.id
                )}
              </span>
            ))}
          </span>
        ) : null}
      </td>
    </tr>
  );
}

function FormGroup({ group, taxYear }: { group: SheetFormGroup; taxYear: 2025 }) {
  return (
    <div className="break-inside-avoid-page space-y-1">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-base font-semibold">{group.form}</h3>
        {group.requirement !== null ? (
          <span className="text-xs text-muted-foreground" title={group.requirement.reason}>
            Packet verdict: {group.requirement.label} - {group.requirement.reason}
          </span>
        ) : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[56rem] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-1 pr-2 font-medium">Line</th>
              <th className="py-1 pr-2 font-medium">Description</th>
              <th className="py-1 pr-2 text-right font-medium">Amount</th>
              <th className="py-1 pr-2 font-medium">Status</th>
              <th className="py-1 pr-2 font-medium">Provenance</th>
              <th className="py-1 font-medium">Citation / reason</th>
            </tr>
          </thead>
          <tbody>
            {group.lines.map((l) => (
              <LineRow key={l.key} line={l} taxYear={taxYear} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PartLines({ id, title, intro, groups, model, withAttestations }: { id: string; title: string; intro: string; groups: SheetFormGroup[]; model: SheetModel; withAttestations?: boolean }) {
  return (
    <section id={id} className="sheet-part space-y-4" aria-labelledby={`${id}-title`}>
      <Draft label={model.draftLabel} />
      <div>
        <h2 id={`${id}-title`} className="text-xl font-semibold">
          {title}
        </h2>
        <p className="text-xs text-muted-foreground">{intro}</p>
      </div>
      {groups.map((g) => (
        <FormGroup key={g.form} group={g} taxYear={model.taxYear} />
      ))}
      {withAttestations ? (
        <div className="break-inside-avoid space-y-1">
          <h3 className="text-base font-semibold">Yes / no questions printed on the return</h3>
          <ul className="space-y-0.5 text-sm">
            {model.attestations.map((a) => (
              <li key={a.label}>
                {a.label}: <span className="font-medium">{a.answerText}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

// ── P4 ────────────────────────────────────────────────────────────────────────

function Alternative({ alt }: { alt: SheetAlternative }) {
  return (
    <div className={`space-y-1 rounded-md border p-3 text-sm ${alt.inForce ? "border-primary/60" : ""}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">{alt.label}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {alt.marker !== null ? <span className="rounded-full border border-amber-400 bg-amber-50 px-2 py-0.5 text-amber-900">{alt.marker}</span> : null}
        {alt.inForce ? <span className="rounded-full border border-primary/50 px-2 py-0.5">in force on this sheet</span> : null}
        <StatusBadge status={alt.status} />
      </div>
      {alt.effectAmountText !== null ? <p>Effect: {alt.effectAmountText}</p> : null}
      {alt.effectNote !== null ? <p className="text-xs">{alt.effectNote}</p> : null}
      {alt.reasons.map((r) => (
        <p key={r} className="text-xs text-muted-foreground">
          {r}
        </p>
      ))}
    </div>
  );
}

function Decision({ d, taxYear, canRecord }: { d: SheetDecision; taxYear: 2025; canRecord: boolean }) {
  return (
    <div className="break-inside-avoid space-y-2 rounded-lg border p-4" data-decision={d.id}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold">
          {d.id}: {d.label}
        </h3>
        <span className={`rounded-full border px-2 py-0.5 text-xs ${d.undecided ? "border-amber-400 bg-amber-50 text-amber-900" : "border-green-300 bg-green-50 text-green-800"}`}>
          {d.statusText}
          {d.decidedBy !== null ? ` - ${d.decidedBy}` : ""}
          {d.decidedAt !== null ? ` - ${d.decidedAt}` : ""}
        </span>
      </div>
      {d.affectedLines.length > 0 ? <p className="text-xs text-muted-foreground">Lines affected: {d.affectedLines.join(", ")}</p> : null}
      {d.override !== null ? (
        <p className="rounded border border-violet-300 bg-violet-50 px-2 py-1 text-xs text-violet-900" data-testid="decision-override-note">
          {d.override.note}
        </p>
      ) : null}
      {canRecord && d.decisionKey !== null ? (
        <div>
          <OverrideDecisionButton
            taxYear={taxYear}
            data={{
              id: d.id,
              label: d.label,
              decisionKey: d.decisionKey,
              undecided: d.undecided,
              choices: d.choices,
              override:
                d.override === null
                  ? null
                  : { id: d.override.id, version: d.override.version, authority: d.override.authority, choice: d.override.choice, note: d.override.note },
            }}
          />
        </div>
      ) : null}
      <div className="grid gap-2 md:grid-cols-2">
        {d.alternatives.map((a) => (
          <Alternative key={a.id} alt={a} />
        ))}
      </div>
      <p className="text-xs">
        <span className="font-semibold">Whole-return effect (the engine&apos;s text): </span>
        {d.wholeReturnEffect}
      </p>
    </div>
  );
}

function PartDecisions({ model }: { model: SheetModel }) {
  return (
    <section id="part-4" className="sheet-part space-y-4" aria-labelledby="part-4-title">
      <Draft label={model.draftLabel} />
      <div>
        <h2 id="part-4-title" className="text-xl font-semibold">
          4. CPA decisions
        </h2>
        <p className="text-xs text-muted-foreground">
          Until a decision is recorded the engine uses the conservative alternative and marks it &quot;default, undecided&quot;.
          Nothing is hidden: every alternative the engine knows is shown side by side. The defaults are not recommendations.
        </p>
      </div>
      {model.decisions.length === 0 ? <p className="text-sm">The engine raised no decision for this return.</p> : null}
      {model.decisions.map((d) => (
        <Decision key={d.id} d={d} taxYear={model.taxYear} canRecord={model.federal.some((g) => g.lines.some((l) => l.canOverride))} />
      ))}
      {model.decisionPlaceholders.length > 0 ? (
        <div className="space-y-1 break-inside-avoid">
          <h3 className="text-base font-semibold">Decisions not raised or not computed yet</h3>
          <ul className="space-y-1 text-sm">
            {model.decisionPlaceholders.map((p) => (
              <li key={p.id}>
                <span className="font-medium">
                  {p.id}: {p.label}.
                </span>{" "}
                <span className="text-muted-foreground">{p.note}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

// ── P5 ────────────────────────────────────────────────────────────────────────

function ItemRow({ item }: { item: SheetOpenItem }) {
  return (
    <tr className="border-b align-top" data-item-id={item.id}>
      <td className="py-1 pr-2">
        <span className={`rounded-full border px-2 py-0.5 text-[11px] ${item.severity === "blocking" ? "border-red-300 bg-red-50 text-red-800" : "border-border bg-muted text-muted-foreground"}`}>
          {item.severity}
        </span>
      </td>
      <td className="py-1 pr-2 text-sm">{item.message}</td>
      <td className="py-1 pr-2 text-xs">{item.action}</td>
      <td className="py-1 pr-2 text-xs">{item.who === "owner" ? "owner" : item.who === "derived" ? "computed from other lines" : "CPA"}</td>
      <td className="py-1 text-xs">{item.lines.length > 0 ? item.lines.map((l) => l.text).join(", ") : "-"}</td>
    </tr>
  );
}

function ItemTable({ items }: { items: SheetOpenItem[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[44rem] text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-1 pr-2 font-medium">Severity</th>
            <th className="py-1 pr-2 font-medium">Item</th>
            <th className="py-1 pr-2 font-medium">Action</th>
            <th className="py-1 pr-2 font-medium">Who</th>
            <th className="py-1 font-medium">Lines</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <ItemRow key={i.id} item={i} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PartOpenItems({ model }: { model: SheetModel }) {
  const direct = model.openItems.filter((i) => i.who !== "derived");
  const derived = model.openItems.filter((i) => i.who === "derived");
  return (
    <section id="part-5" className="sheet-part space-y-4" aria-labelledby="part-5-title">
      <Draft label={model.draftLabel} />
      <div>
        <h2 id="part-5-title" className="text-xl font-semibold">
          5. Open items, conflicts and owner homework
        </h2>
        <p className="text-xs text-muted-foreground">Blocking items first. Each item lists the return lines it affects.</p>
      </div>
      <ItemTable items={direct} />
      {direct.length === 0 ? <p className="py-2 text-sm">No open items.</p> : null}
      {derived.length > 0 ? (
        <div className="space-y-1" data-testid="derived-items">
          <h3 className="text-base font-semibold">Computed from other lines ({derived.length})</h3>
          <p className="text-xs text-muted-foreground">
            These items only wait for figures the engine computes from other lines (taxable income, AGI, Schedule C profit ...). Nobody has to
            provide them: they resolve when the owner answers the homework items below and the CPA settles the items above.
          </p>
          <ItemTable items={derived} />
        </div>
      ) : null}

      <div className="break-inside-avoid space-y-1">
        <h3 className="text-base font-semibold">Conflicts between sources</h3>
        {model.conflicts.length === 0 ? <p className="text-sm text-muted-foreground">None detected.</p> : null}
        <ul className="space-y-2 text-sm">
          {model.conflicts.map((c) => (
            <li key={c.factKey} className="rounded-md border p-2">
              <p className="font-medium">{c.factKey}</p>
              <p className="text-xs">{c.reason}</p>
              <ul className="mt-1 list-disc pl-5 text-xs">
                {c.candidates.map((x, i) => (
                  <li key={`${x.label}-${i}`}>
                    {x.basisLabel}: {x.label} = {x.valueText}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">Used: {c.chosen ?? "none of them"}</p>
            </li>
          ))}
        </ul>
      </div>

      <div className="break-inside-avoid space-y-1">
        <h3 className="text-base font-semibold">What Eric and Eva still need to answer or verify</h3>
        {model.homework.length === 0 ? <p className="text-sm text-muted-foreground">Nothing is waiting on the owners.</p> : null}
        <ol className="space-y-1.5 text-sm">
          {model.homework.map((h) => (
            <li key={h.id} className="flex gap-2">
              <span className="mt-1 inline-block h-3 w-3 shrink-0 border border-foreground" aria-hidden="true" />
              <span>
                <span className="font-medium">{h.what}</span>{" "}
                <span className="text-muted-foreground">
                  ({h.severity}) {h.why}
                  {h.lines.length > 0 ? ` Lines: ${h.lines.join(", ")}.` : ""}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ── P6 ────────────────────────────────────────────────────────────────────────

function PartDocuments({ model }: { model: SheetModel }) {
  return (
    <section id="part-6" className="sheet-part space-y-4" aria-labelledby="part-6-title">
      <Draft label={model.draftLabel} />
      <div>
        <h2 id="part-6-title" className="text-xl font-semibold">
          6. Document index and CPA sign-off checklist
        </h2>
        <p className="text-xs text-muted-foreground">Which documents fed which lines. Unverified documents are listed first.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-1 pr-2 font-medium">Document</th>
              <th className="py-1 pr-2 font-medium">Year</th>
              <th className="py-1 pr-2 font-medium">Status</th>
              <th className="py-1 font-medium">Fed these lines</th>
            </tr>
          </thead>
          <tbody>
            {model.documents.map((d) => (
              <tr key={d.id} className="border-b align-top">
                <td className="py-1 pr-2">
                  <Link href={d.href as Route} prefetch={false} className="text-primary hover:underline">
                    {d.docTypeLabel}
                  </Link>
                  {d.subject !== null ? <span className="text-xs text-muted-foreground"> ({d.subject})</span> : null}
                </td>
                <td className="py-1 pr-2 text-xs">{d.taxYear ?? "-"}</td>
                <td className="py-1 pr-2">
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] ${d.verified ? CHIP_CLASS.document_verified : CHIP_CLASS.document_unverified}`}>{d.statusText}</span>
                </td>
                <td className="py-1 text-xs">{d.fedLines.length > 0 ? d.fedLines.map((l) => l.text).join(", ") : "not used by any line"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {model.documents.length === 0 ? <p className="py-2 text-sm">No documents are on file for this year.</p> : null}
      </div>

      <div className="break-inside-avoid space-y-1">
        <h3 className="text-base font-semibold">Constants and citations used</h3>
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {model.citations.map((c) => (
            <li key={c.id}>
              {c.url !== null ? (
                <a href={c.url} target="_blank" rel="noreferrer" className="underline" title={c.note ?? undefined}>
                  {c.id}
                </a>
              ) : (
                c.id
              )}
              {c.verifiedOn !== null ? <span className="text-muted-foreground"> ({c.verifiedOn})</span> : null}
            </li>
          ))}
        </ul>
      </div>

      <div className="break-inside-avoid space-y-1">
        <h3 className="text-base font-semibold">CPA sign-off checklist</h3>
        <ol className="space-y-1.5 text-sm" data-testid="signoff-checklist">
          {model.checklist.map((c) => (
            <li key={c} className="flex gap-2">
              <span className="mt-1 inline-block h-3 w-3 shrink-0 border border-foreground" aria-hidden="true" />
              <span>{c}</span>
            </li>
          ))}
        </ol>
        <p className="pt-3 text-xs text-muted-foreground">
          Reviewed by: ______________________ Date: ______________ (the CPA is the preparer of record; this sheet is not a filed return).
        </p>
      </div>
    </section>
  );
}

export function ReturnSheet({ model }: { model: SheetModel }) {
  return (
    <div className="space-y-8">
      {/* Repeats on every printed page (fixed to the page box in print only; hidden on screen). */}
      <div
        className="sheet-print-header hidden border-b border-amber-600 bg-white px-2 py-0.5 text-center text-[9px] font-semibold text-amber-950 print:fixed print:left-0 print:right-0 print:top-0 print:block"
        data-testid="print-header"
      >
        {model.draftLabel}
      </div>
      <PartSummary model={model} />
      <PartLines
        id="part-2"
        title="2. Federal return, line by line"
        intro="Every line the engine emits, grouped by form. Amounts are whole dollars; a line that is not computed says so and is never zero."
        groups={model.federal}
        model={model}
        withAttestations
      />
      <PartLines
        id="part-3"
        title="3. Connecticut return, line by line"
        intro="CT-1040 lines and the Connecticut figures derived from the federal return."
        groups={model.connecticut}
        model={model}
      />
      <PartDecisions model={model} />
      <PartOpenItems model={model} />
      <PartDocuments model={model} />
    </div>
  );
}
