export type GalleryPhoto = { src: string; alt?: string };

export function galleryPhotoAlt(photo: GalleryPhoto, index: number, total: number): string {
  return photo.alt?.trim() || `RegenHub community photo ${index + 1} of ${total}`;
}
