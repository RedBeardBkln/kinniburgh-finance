import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 }); // filling several real IRS forms per test; the 5 s default is tuned for one
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCatalog, serializeCatalog } from "@/lib/tax2025/pdf/catalog";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { PENDING_LINE_KEYS } from "@/lib/tax2025/pdf/pending-line-keys";
import {
  ALLOWED_HOSTS,
  blankPath,
  catalogPath,
  getBlankBytes,
  getManifestEntry,
  isAllowedUrl,
  isKnownFormId,
  listFormIds,
  loadManifest,
  sha256Hex,
  verifyBlankBytes,
} from "@/lib/tax2025/pdf/registry";
import { decodeXmlEntities, scanXfaFields } from "@/lib/tax2025/pdf/xfa";
import { LINE_KEYS } from "@/lib/tax2025/types";

// XFA field name sets known to differ from the AcroForm set (verified at planning time).
const KNOWN_XFA_ONLY: Readonly<Record<string, number>> = { f8949: 1 };

describe("blank-form manifest", () => {
  const manifest = loadManifest();

  it("lists the planned forms and only TY2025", () => {
    expect(manifest.taxYear).toBe(2025);
    for (const id of ["f1040", "f1040s1", "f1040s2", "f1040s3", "f1040sa", "f1040sc", "f1040sse", "f1040sb", "f8995", "f8959", "ct1040", "f5695"]) {
      expect(isKnownFormId(id), id).toBe(true);
    }
    expect(listFormIds().length).toBe(manifest.forms.length);
    expect(new Set(listFormIds()).size).toBe(manifest.forms.length);
  });

  it("every entry is TY2025, from an allowed host, and has a file whose sha256 and size match", () => {
    for (const e of manifest.forms) {
      expect(e.taxYear, e.formId).toBe(2025);
      expect(isAllowedUrl(e.url), `${e.formId} url ${e.url}`).toBe(true);
      expect(existsSync(blankPath(e.formId)), `${e.formId} file`).toBe(true);
      const bytes = new Uint8Array(readFileSync(blankPath(e.formId)));
      expect(sha256Hex(bytes), e.formId).toBe(e.sha256);
      expect(bytes.length, e.formId).toBe(e.bytes);
      expect(String.fromCharCode(...bytes.subarray(0, 5)), e.formId).toBe("%PDF-");
    }
  });

  it("getBlankBytes returns the verified bytes", () => {
    const e = getManifestEntry("f1040");
    expect(sha256Hex(getBlankBytes("f1040"))).toBe(e.sha256);
  });

  it("detects a single changed byte (tamper detection)", () => {
    const e = getManifestEntry("f1040");
    const bytes = new Uint8Array(readFileSync(blankPath("f1040")));
    expect(() => verifyBlankBytes(e, bytes)).not.toThrow();
    const tampered = new Uint8Array(bytes);
    const at = 1000;
    tampered[at] = (tampered[at] ?? 0) ^ 0xff;
    expect(() => verifyBlankBytes(e, tampered)).toThrow(/sha256 mismatch/);
    expect(() => verifyBlankBytes(e, bytes.subarray(0, bytes.length - 1))).toThrow(/mismatch/);
  });

  it("rejects non-allowlisted, non-https and malformed URLs", () => {
    expect(ALLOWED_HOSTS).toEqual(["www.irs.gov", "portal.ct.gov"]);
    expect(isAllowedUrl("https://www.irs.gov/pub/irs-prior/f1040--2025.pdf")).toBe(true);
    expect(isAllowedUrl("https://portal.ct.gov/-/media/drs/forms/2025/income/ct-1040_1225.pdf")).toBe(true);
    expect(isAllowedUrl("http://www.irs.gov/x.pdf")).toBe(false);
    expect(isAllowedUrl("https://evil.example.com/f1040.pdf")).toBe(false);
    expect(isAllowedUrl("https://www.irs.gov.evil.example.com/f1040.pdf")).toBe(false);
    expect(isAllowedUrl("not a url")).toBe(false);
  });

  it("route whitelist rejects unknown ids", () => {
    expect(isKnownFormId("f1040")).toBe(true);
    expect(isKnownFormId("../../etc/passwd")).toBe(false);
    expect(isKnownFormId("f9999")).toBe(false);
    expect(() => getManifestEntry("f9999")).toThrow(/Unknown form id/);
  });

  it("every FormMap references a manifest entry", () => {
    for (const m of FORM_MAPS) expect(isKnownFormId(m.formId), m.formId).toBe(true);
  });

  it("flat CT-1040 has no fields; hybrid IRS forms carry XFA", () => {
    expect(getManifestEntry("ct1040").sourceKind).toBe("flat");
    expect(getManifestEntry("ct1040").fieldCount).toBe(0);
    expect(getManifestEntry("f1040").sourceKind).toBe("acroform_hybrid_xfa");
    expect(getManifestEntry("f1040").fieldCount).toBe(199);
  });
});

describe("field catalogs", () => {
  it("each committed catalog equals a fresh catalog of the blank PDF (field set, pages, count)", async () => {
    for (const e of loadManifest().forms) {
      const fresh = await buildCatalog(e.formId, getBlankBytes(e.formId));
      expect(fresh.pages, `${e.formId} pages`).toBe(e.pages);
      expect(fresh.fieldCount, `${e.formId} fieldCount`).toBe(e.fieldCount);
      expect(fresh.hadXfa, `${e.formId} xfa`).toBe(e.sourceKind === "acroform_hybrid_xfa");
      const committed = readFileSync(catalogPath(e.formId), "utf8").replace(/\r\n/g, "\n");
      expect(serializeCatalog(fresh), `${e.formId} catalog is stale: run pnpm forms:catalog`).toBe(committed);
    }
  }, 60000);

  it("XFA and AcroForm field sets agree (allowing the known Form 8949 extra)", async () => {
    for (const e of loadManifest().forms) {
      const fresh = await buildCatalog(e.formId, getBlankBytes(e.formId));
      expect(fresh.acroOnlyFields, `${e.formId} acro-only`).toEqual([]);
      expect(fresh.xfaOnlyFields.length, `${e.formId} xfa-only`).toBeLessThanOrEqual(KNOWN_XFA_ONLY[e.formId] ?? 0);
    }
  }, 60000);

  it("every hybrid-form field has an XFA description except none expected on the 1040", async () => {
    const c = JSON.parse(readFileSync(catalogPath("f1040"), "utf8")) as { fields: Array<{ name: string; speak: string | null }> };
    expect(c.fields.length).toBe(199);
    expect(c.fields.filter((f) => f.speak === null)).toEqual([]);
    const line1a = c.fields.find((f) => f.name === "topmostSubform[0].Page1[0].f1_47[0]");
    expect(line1a?.speak).toMatch(/1a\. Total amount from Form\(s\) W-2, box 1/);
    const mfj = c.fields.find((f) => f.name === "topmostSubform[0].Page1[0].Checkbox_ReadOrder[0].c1_8[1]");
    expect(mfj?.speak).toMatch(/Married filing jointly/);
  });
});

describe("XFA template scanner", () => {
  const xml = `<?xml version="1.0"?>
<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">
 <subform name="top">
  <subform name="Page1">
   <!-- <field name="commented"/> -->
   <subform>
    <field name="a"><assist><speak>1a. Wages &amp; tips &#8211; &lt;box 1&gt;</speak></assist></field>
    <field name="a"><assist><speak><![CDATA[second <a>]]></speak></assist></field>
   </subform>
   <field name="b"><event><script>if (a &gt; 1 &amp;&amp; b &lt; 2) { x = "q" }</script></event></field>
   <field name="c"/>
  </subform>
  <subform name="Page1"><field name="a"><assist><speak>other page</speak></assist></field></subform>
 </subform>
</template>`;

  it("builds indexed paths, treats unnamed subforms as transparent, decodes entities", () => {
    const fields = scanXfaFields(xml);
    expect(fields.map((f) => f.name)).toEqual([
      "top[0].Page1[0].a[0]",
      "top[0].Page1[0].a[1]",
      "top[0].Page1[0].b[0]",
      "top[0].Page1[0].c[0]",
      "top[0].Page1[1].a[0]",
    ]);
    expect(fields[0]?.speak).toBe("1a. Wages & tips – <box 1>");
    expect(fields[1]?.speak).toBe("second <a>");
    expect(fields[2]?.speak).toBeNull();
    expect(fields[4]?.speak).toBe("other page");
  });

  it("decodes numeric and named entities", () => {
    expect(decodeXmlEntities("a&amp;b &#x41;&#66; &quot;q&quot; &unknown;")).toBe('a&b AB "q" &unknown;');
  });
});

describe("pending line keys", () => {
  it("no stale pending: a pending key that became a real LINE_KEY must be removed from the pending list", () => {
    const real = new Set<string>(LINE_KEYS);
    const stale = PENDING_LINE_KEYS.filter((k) => real.has(k));
    expect(stale, "move to LINE_KEYS usage / delete from pending").toEqual([]);
  });

  it("has no duplicates", () => {
    expect(new Set(PENDING_LINE_KEYS).size).toBe(PENDING_LINE_KEYS.length);
  });

  it("every map line key is a LINE_KEY or a pending key", () => {
    const allowed = new Set<string>([...LINE_KEYS, ...PENDING_LINE_KEYS]);
    for (const m of FORM_MAPS) {
      for (const l of m.lines) if (l.kind === "money") expect(allowed.has(l.line), `${m.formId} ${l.line}`).toBe(true);
    }
  });
});
