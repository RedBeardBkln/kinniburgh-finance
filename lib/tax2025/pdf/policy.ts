// The blank policy (plan section 6.4) as pure functions. A line that has no value
// is left BLANK with an open item, never 0. Nothing here touches a PDF.
//
//   computed, != 0          -> the amount
//   computed, == 0          -> blank on detail lines; "0" only when the map says zero:"print"
//                              (IRS convention: a blank is zero; the cover states it)
//   overridden (CPA pin)    -> the override amount (an explicit "0" pin prints "0"); /TU note
//   default undecided       -> the amount; /TU "default, undecided: <decision label>"
//   not_applicable          -> blank (or "0" with zero:"print")
//   missing_input / needs_cpa_* -> blank + BLOCKING item
//   not_yet_computed        -> blank + advisory item
//   no ReturnLine at all    -> blank; an item only when the map flags expected:true

import { formatDollars } from "@/lib/tax2025/pdf/format";
import type {
  FormMap,
  MapMoneyLine,
  PacketOpenItem,
  PdfLine,
  PdfReturnView,
} from "@/lib/tax2025/pdf/types";

export interface MoneyDecision {
  /** Text to write, or null to leave the field blank. */
  write: string | null;
  /** Field tooltip (/TU) note: override or "default, undecided". */
  tooltip?: string;
  items: PacketOpenItem[];
}

function blankItem(formId: string, line: PdfLine, severity: "blocking" | "advisory", why: string): PacketOpenItem {
  return {
    id: `blank:${formId}:${line.key}`,
    severity,
    source: "line_blank",
    formId,
    lineKey: line.key,
    message: `${line.formLabel} line ${line.formLine} (${line.label}): left blank - ${why}`,
  };
}

/** Decide what goes in the field of one money map entry. */
export function resolveFieldValue(formId: string, line: PdfLine | undefined, entry: MapMoneyLine): MoneyDecision {
  if (line === undefined) {
    const items: PacketOpenItem[] = [];
    if (entry.expected) {
      items.push({
        id: `noemit:${formId}:${entry.line}`,
        severity: "advisory",
        source: "line_blank",
        formId,
        lineKey: entry.line,
        message: `Line ${entry.line} is not emitted by the engine yet and the form needs it; left blank - key it manually.`,
      });
    }
    return { write: null, items };
  }

  switch (line.status) {
    case "computed":
    case "overridden":
    case "not_applicable": {
      const amount = line.amount;
      if (amount === null) {
        return {
          write: null,
          items: [blankItem(formId, line, "blocking", "the engine returned no amount for a line that should carry one")],
        };
      }
      if (!Number.isSafeInteger(amount)) {
        return {
          write: null,
          items: [blankItem(formId, line, "blocking", "the amount is not a whole-dollar integer; refusing to write a float")],
        };
      }
      const tooltip =
        line.status === "overridden" && line.override
          ? line.override.note
          : line.defaultUndecided
            ? `default, undecided: ${line.defaultUndecided}`
            : undefined;
      let write: string | null;
      if (line.status === "not_applicable") {
        write = entry.zero === "print" ? "0" : null;
      } else if (amount === 0) {
        // An explicit CPA pin of $0 is an instruction and prints; a computed zero prints only where the form wants it.
        write = line.status === "overridden" || entry.zero === "print" ? "0" : null;
      } else {
        write = formatDollars(amount);
      }
      const decision: MoneyDecision = { write, items: [] };
      if (tooltip !== undefined && write !== null) decision.tooltip = tooltip;
      return decision;
    }
    case "missing_input":
    case "needs_cpa_rule_unverified":
    case "needs_cpa_judgment":
      return { write: null, items: [blankItem(formId, line, "blocking", line.reason ?? line.status)] };
    case "not_yet_computed":
      return {
        write: null,
        items: [blankItem(formId, line, "advisory", "not yet computed by the engine; key it manually. " + (line.reason ?? ""))],
      };
  }
}

export interface Inclusion {
  include: boolean;
  reason: string;
}

/**
 * Inclusion rule (plan 5.2 C7): include a form iff (a) it is the 1040, or (b) any mapped
 * money line is computed/overridden with a non-zero amount, or (c) any mapped line is
 * missing_input / needs_cpa_* (the CPA needs the form to see the blank). Never when
 * every mapped line is not_applicable, zero, not_yet_computed or absent.
 */
export function formInclusion(map: FormMap, view: PdfReturnView): Inclusion {
  if (map.formId === "f1040") return { include: true, reason: "Form 1040 is always included" };
  let allAbsent = true;
  for (const entry of map.lines) {
    if (entry.kind !== "money") continue;
    const line = view.lines[entry.line];
    if (!line) continue;
    allAbsent = false;
    if ((line.status === "computed" || line.status === "overridden") && line.amount !== null && line.amount !== 0) {
      return { include: true, reason: `line ${line.formLine} has a computed amount` };
    }
    if (
      line.status === "missing_input" ||
      line.status === "needs_cpa_rule_unverified" ||
      line.status === "needs_cpa_judgment"
    ) {
      return { include: true, reason: `line ${line.formLine} needs input or a CPA decision` };
    }
  }
  return {
    include: false,
    reason: allAbsent
      ? "the engine emitted no line for this form"
      : "every mapped line is not applicable, zero or not yet computed",
  };
}
