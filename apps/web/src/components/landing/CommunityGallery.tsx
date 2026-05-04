import fs from "node:fs/promises";
import path from "node:path";
import CommunityGalleryClient from "./CommunityGalleryClient";

const PHOTO_DIR = path.join(process.cwd(), "public", "regenhubphotos");
const PHOTO_PATTERN = /\.(jpe?g|png|webp)$/i;

/**
 * Reads `public/regenhubphotos/` at request time and hands the URL list to
 * the client component for shuffling + auto-rotation. No build-step manifest
 * needed — drop a file in the directory and the next render picks it up.
 *
 * `/` is already server-rendered (auth check), so this `readdir` adds no new
 * dynamic-ness. The client component handles the Fisher-Yates shuffle so
 * each visit gets a different ordering.
 */
export default async function CommunityGallery() {
  let photos: string[] = [];
  try {
    const files = await fs.readdir(PHOTO_DIR);
    photos = files
      .filter((f) => PHOTO_PATTERN.test(f))
      .map((f) => `/regenhubphotos/${f}`);
  } catch (err) {
    console.error("[CommunityGallery] Failed to read photo directory:", err);
    return null;
  }

  if (photos.length === 0) return null;

  return <CommunityGalleryClient photos={photos} />;
}
