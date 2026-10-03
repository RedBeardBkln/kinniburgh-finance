// Public surface of the TY2025 PDF engine core. Server-only (fs, crypto, pdf-lib).
// Everything downstream (routes, adapter) imports from here.

export * from "@/lib/tax2025/pdf/types";
export { PENDING_LINE_KEYS, type PendingLineKey } from "@/lib/tax2025/pdf/pending-line-keys";
export {
  ALLOWED_HOSTS,
  SUPPORTED_YEAR,
  getBlankBytes,
  getManifestEntry,
  isAllowedUrl,
  isKnownFormId,
  listFormIds,
  loadManifest,
  type Manifest,
  type ManifestEntry,
} from "@/lib/tax2025/pdf/registry";
export { buildCatalog, type CatalogField, type FormCatalog } from "@/lib/tax2025/pdf/catalog";
export { checkCompleteness, collectClaims, type CompletenessReport } from "@/lib/tax2025/pdf/completeness";
export { sanitizeWinAnsi } from "@/lib/tax2025/pdf/winansi";
export {
  NEGATIVE_STYLE,
  canonicalJson,
  fingerprintOf,
  formatDollars,
  formatNewYorkDate,
  formatNewYorkDateTime,
  shortFingerprint,
  splitName,
} from "@/lib/tax2025/pdf/format";
export { formInclusion, resolveFieldValue, type Inclusion, type MoneyDecision } from "@/lib/tax2025/pdf/policy";
export { fillForm, OVERFLOW_LABEL } from "@/lib/tax2025/pdf/fill";
export { ALTERNATIVE_STAMP_TEXT, draftStampText, stampPages } from "@/lib/tax2025/pdf/stamp";
export { buildCoverModel, renderCover, type CoverForm, type CoverInput, type CoverModel } from "@/lib/tax2025/pdf/cover";
export {
  COVER_FILE_NAME,
  PACKET_ORDER,
  buildPacket,
  orderMaps,
  type PacketFile,
  type PacketOptions,
  type PacketResult,
} from "@/lib/tax2025/pdf/packet";
export { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
