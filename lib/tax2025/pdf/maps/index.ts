// Registry of every FormMap the packet knows (one line each). T2a: 1040 + Schedules 1,
// 2, 3; T2b: Schedules A, C, SE. T3 (Schedule B, 8995, 8959) and the CT-1040 add theirs; Schedule D and
// Form 8949 (the capital-gains work) come after Schedule C; Schedule 1-A and Form 8960 were added last.

import type { FormMap } from "@/lib/tax2025/pdf/types";
import { ct1040Map } from "@/lib/tax2025/pdf/maps/ct1040";
import { f1040Map } from "@/lib/tax2025/pdf/maps/f1040";
import { f8949Map } from "@/lib/tax2025/pdf/maps/f8949";
import { f8959Map } from "@/lib/tax2025/pdf/maps/f8959";
import { f8995Map } from "@/lib/tax2025/pdf/maps/f8995";
import { sch1Map } from "@/lib/tax2025/pdf/maps/sch1";
import { sch1aMap } from "@/lib/tax2025/pdf/maps/sch1a";
import { sch2Map } from "@/lib/tax2025/pdf/maps/sch2";
import { sch3Map } from "@/lib/tax2025/pdf/maps/sch3";
import { schAMap } from "@/lib/tax2025/pdf/maps/schA";
import { schBMap } from "@/lib/tax2025/pdf/maps/schB";
import { schCMap } from "@/lib/tax2025/pdf/maps/schC";
import { schDMap } from "@/lib/tax2025/pdf/maps/schD";
import { schSEMap } from "@/lib/tax2025/pdf/maps/schSE";

export const FORM_MAPS: readonly FormMap[] = [
  f1040Map,
  sch1Map,
  sch2Map,
  sch3Map,
  schAMap,
  schBMap,
  schCMap,
  schDMap,
  f8949Map,
  schSEMap,
  f8995Map,
  f8959Map,
  ct1040Map,
  sch1aMap,
];
