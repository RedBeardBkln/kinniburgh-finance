/**
 * One-time generator for Android adaptive-icon "maskable" variants of the
 * PWA icons. Android's adaptive-icon system crops a `purpose: "maskable"`
 * icon to a circle/squircle mask, showing only the center ~80% "safe zone" —
 * the source icons are full-bleed art with banner text close to the edge,
 * so they'd clip under that mask if reused as-is.
 *
 * For each source size, this resizes the source art down to 80% and
 * composites it centered onto an opaque canvas filled with a color sampled
 * from the source image's own top-left corner pixel (the source art's
 * background is a green radial gradient, not the manifest's amber theme
 * color, so sampling from the source avoids a clashing hard-edged fill).
 *
 * Not a runtime code path — run once locally and commit the output:
 *   pnpm generate:maskable-icons
 */

import sharp from "sharp";
import { join } from "path";

const SIZES = [192, 512] as const;
const SAFE_ZONE_SCALE = 0.8;

async function generateOne(size: number): Promise<void> {
  const publicDir = join(process.cwd(), "public");
  const sourcePath = join(publicDir, `web-app-manifest-${size}x${size}.png`);
  const outputPath = join(publicDir, `web-app-manifest-${size}x${size}-maskable.png`);

  const source = sharp(sourcePath);

  // Sample a fill color from the source's own top-left corner pixel rather
  // than hardcoding the manifest's amber theme color, which would clash
  // against the source art's green gradient background.
  const cornerPixel = await source
    .clone()
    .extract({ left: 0, top: 0, width: 1, height: 1 })
    .raw()
    .toBuffer();
  const background = {
    r: cornerPixel.readUInt8(0),
    g: cornerPixel.readUInt8(1),
    b: cornerPixel.readUInt8(2),
  };
  const hex = `#${[background.r, background.g, background.b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  console.log(`[${size}x${size}] sampled background color: ${hex}`);

  const innerSize = Math.round(size * SAFE_ZONE_SCALE);
  const resized = await source
    .clone()
    .resize(innerSize, innerSize)
    .toBuffer();

  const offset = Math.round((size - innerSize) / 2);

  await sharp({
    create: {
      width: size,
      height: size,
      channels: 3,
      background,
    },
  })
    .composite([{ input: resized, left: offset, top: offset }])
    .flatten({ background })
    .removeAlpha()
    .png()
    .toFile(outputPath);

  console.log(`[${size}x${size}] wrote ${outputPath}`);
}

async function main() {
  for (const size of SIZES) {
    await generateOne(size);
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
