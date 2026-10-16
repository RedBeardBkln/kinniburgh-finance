// The GL role map of the invoicing profile (plan section 5). PURE. Live GL code NUMBERS are never hardcoded: the setup screen
// PRESELECTS each role by matching the chart's account NAMES (the CPA chart names in lib/invoicing/constants.ts#GL_ROLE_NAME_HINTS)
// and the owner confirms. Validation: each id must belong to this entity, not be archived and have the type the role expects
// (revenue is "revenue", never "income").

import { GL_ROLES, GL_ROLE_NAME_HINTS, GL_ROLE_TYPES, type GlRole } from "@/lib/invoicing/constants";

export interface GlCodeLite {
  id: string;
  entityId: string;
  code: string;
  name: string;
  type: string;
  archivedAt: Date | null;
}

export type GlMap = Record<GlRole, string>;

/** Best name match per role among the live accounts of the right type. Roles with no match are simply absent. */
export function suggestGlMap(codes: readonly GlCodeLite[]): Partial<GlMap> {
  const live = codes.filter((c) => c.archivedAt === null);
  const out: Partial<GlMap> = {};
  for (const role of GL_ROLES) {
    const wantType = GL_ROLE_TYPES[role];
    const pool = live.filter((c) => c.type === wantType);
    for (const hint of GL_ROLE_NAME_HINTS[role]) {
      const exact = pool.find((c) => c.name.trim().toLowerCase() === hint);
      const partial = exact ?? pool.find((c) => c.name.trim().toLowerCase().includes(hint));
      if (partial) {
        out[role] = partial.id;
        break;
      }
    }
  }
  return out;
}

export type GlMapCheck = { ok: true; map: GlMap } | { ok: false; error: string };

export function validateGlMap(input: Partial<Record<GlRole, string | null | undefined>>, entityId: string, codes: readonly GlCodeLite[]): GlMapCheck {
  const byId = new Map(codes.map((c) => [c.id, c]));
  const map: Partial<GlMap> = {};
  for (const role of GL_ROLES) {
    const id = input[role];
    if (!id) return { ok: false, error: `Choose an account for "${role}".` };
    const c = byId.get(id);
    if (!c || c.entityId !== entityId) return { ok: false, error: "One of the chosen accounts does not belong to this business." };
    if (c.archivedAt !== null) return { ok: false, error: `The account "${c.name}" is archived. Choose another.` };
    if (c.type !== GL_ROLE_TYPES[role]) return { ok: false, error: `The account "${c.name}" has the wrong type for this role (needs ${GL_ROLE_TYPES[role]}).` };
    map[role] = id;
  }
  return { ok: true, map: map as GlMap };
}

/** Reads the stored Json back into a complete map, or null when it is missing or incomplete. */
export function readGlMap(raw: unknown): GlMap | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const map: Partial<GlMap> = {};
  for (const role of GL_ROLES) {
    const v = o[role];
    if (typeof v !== "string" || v === "") return null;
    map[role] = v;
  }
  return map as GlMap;
}
