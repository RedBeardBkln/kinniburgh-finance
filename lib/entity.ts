import { db } from "@/lib/db";

export type EntityNav = {
  id: string;
  name: string;
  slug: string;
  navLabel: string;
  type: string;
};

export type NavBucket = {
  slug: string;
  label: string;
  type: "personal" | "business" | "taxes" | "projects";
  id: string | null;
};

/**
 * Returns the entity for a URL slug, or null for the "taxes" aggregate view.
 * Works for both static slugs (personal, sudden-valley, etc.) and dynamic ones.
 */
export async function getEntityBySlug(
  slug: string
): Promise<{ id: string; name: string; slug: string | null; navLabel: string | null; type: string } | null> {
  if (slug === "taxes") return null;
  return db.entity.findFirst({
    where: { slug },
    select: { id: true, name: true, slug: true, navLabel: true, type: true },
  });
}

/**
 * Returns all visible navigation buckets in display order:
 * Personal → business entities (by navLabel) → Taxes
 */
export async function getNavBuckets(): Promise<NavBucket[]> {
  const entities = await db.entity.findMany({
    where: { slug: { not: null }, hiddenInNav: false },
    orderBy: { navLabel: "asc" },
    select: { id: true, slug: true, navLabel: true, name: true, type: true },
  });

  const personal = entities.find((e) => e.slug === "personal");
  const businesses = entities.filter((e) => e.type === "business");

  return [
    ...(personal
      ? [{ slug: "personal", label: personal.navLabel ?? "Personal", type: "personal" as const, id: personal.id }]
      : []),
    ...businesses.map((e) => ({
      slug: e.slug!,
      label: e.navLabel ?? e.name,
      type: "business" as const,
      id: e.id,
    })),
    { slug: "taxes", label: "Taxes", type: "taxes" as const, id: null },
    { slug: "projects", label: "Projects", type: "projects" as const, id: null },
  ];
}

/**
 * Returns a deep-link href into each entity's current-year tax workspace
 * (Personal → the personal tax-form-plan flow; business → its TaxWorkspace,
 * falling back to an anchor on the Taxes overview page if none exists yet).
 * Used to build the "Entities" section of the Taxes sidebar.
 */
export async function getTaxEntityLinks(
  entityBuckets: { id: string; slug: string; label: string }[],
  currentYear: number
): Promise<{ slug: string; label: string; href: string }[]> {
  const workspaces = await db.taxWorkspace.findMany({
    where: { taxYear: currentYear, entityId: { in: entityBuckets.map((e) => e.id) } },
    select: { entityId: true, id: true },
  });
  const wsByEntity = new Map(workspaces.map((w) => [w.entityId, w.id]));
  return entityBuckets.map((e) => ({
    slug: e.slug,
    label: e.label,
    href:
      e.slug === "personal"
        ? `/tax/personal/${currentYear}`
        : wsByEntity.has(e.id)
          ? `/tax/${wsByEntity.get(e.id)}`
          : `/tax#year-${currentYear}`,
  }));
}

/**
 * Returns ALL business entities (including hidden) for the settings management page.
 */
export async function getAllBusinessEntities() {
  return db.entity.findMany({
    where: { type: "business" },
    orderBy: { navLabel: "asc" },
    select: { id: true, name: true, slug: true, navLabel: true, hiddenInNav: true },
  });
}
