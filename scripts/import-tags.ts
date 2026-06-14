/**
 * Import tags from data/tags 2026.csv verbatim (including known quirks).
 * Expected result: 135 tags.
 * Run with: pnpm import:tags
 */

import { parse } from "csv-parse/sync";
import { readFileSync } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

interface CsvRow {
  "TAG NAME": string;
  "PARENT TAG NAME": string;
}

async function main() {
  const csvPath = join(process.cwd(), "data", "tags 2026.csv");
  const raw = readFileSync(csvPath, "utf-8");

  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as CsvRow[];

  console.log(`Parsed ${rows.length} rows from CSV (expected 135).`);

  // First pass: create all tags without parentId (resolve parents in second pass)
  const created = new Map<string, string>(); // tagName → id

  // Sort: parents before children (root tags first, then by depth)
  const sorted = [...rows].sort((a, b) => {
    const depthA = a["TAG NAME"].split("/").length;
    const depthB = b["TAG NAME"].split("/").length;
    return depthA - depthB;
  });

  let insertCount = 0;

  for (const row of sorted) {
    const name = row["TAG NAME"];
    const parentName = row["PARENT TAG NAME"] ?? "";

    // Derive short name from the last "/" segment, trimmed
    const segments = name.split("/");
    const shortName = (segments[segments.length - 1] ?? name).trim();

    // Resolve parent id
    let parentId: string | null = null;
    if (parentName) {
      parentId = created.get(parentName) ?? null;
      if (!parentId) {
        // Parent may have a case mismatch — search case-insensitively
        const match = await db.tag.findFirst({
          where: { name: { equals: parentName, mode: "insensitive" } },
        });
        parentId = match?.id ?? null;
      }
    }

    const tag = await db.tag.upsert({
      where: { name },
      update: { shortName, parentId },
      create: { name, shortName, parentId },
    });

    created.set(name, tag.id);
    insertCount++;
  }

  const total = await db.tag.count();
  console.log(`Done. ${insertCount} tags upserted; ${total} total in DB.`);

  if (total !== 135) {
    console.warn(`WARNING: expected 135 tags, got ${total}. Run pnpm validate.`);
  } else {
    console.log("Tag count verified: 135 ✓");
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
