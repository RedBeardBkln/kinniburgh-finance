// Pure RFC-4180 CSV line parsing — handles quoted fields with embedded
// commas, escaped double-quotes, and CRLF. Client-safe.

/**
 * Parses one CSV line into cells. Quotes: `"a,b" → a,b`, `"He said ""hi""" → He said "hi".
 * Unquoted cells run to the next comma. No multi-line quoted fields (Airbnb
 * exports keep guest/listing names on a single line).
 */
export function parseCsvCells(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

/**
 * Splits raw CSV text into trimmed non-empty lines, normalizing CRLF.
 */
export function splitCsvLines(csvText: string): string[] {
  return csvText
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Parses a money string like "$1,200.00" or "450.50" or "(12.00)" into a
 * float, or NaN when it isn't a number.
 */
export function parseMoney(raw: string): number {
  const cleaned = raw.replace(/[$,\s]/g, "");
  return parseFloat(cleaned);
}

/**
 * Parses MM/DD/YYYY into a UTC Date, or null when invalid.
 * Round-trip check catches JS Date auto-rolling (13/45/2026 → Feb next year).
 */
export function parseMdyDate(raw: string): Date | null {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (isNaN(date.getTime())) return null;
  // Guard against overflow (e.g. 2/30/2026 rolls to March 2)
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}