"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Autoplay from "embla-carousel-autoplay";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  type CarouselApi,
} from "@/components/ui/carousel";
import { Card } from "@/components/ui/card";

import { galleryPhotoAlt, type GalleryPhoto } from "./galleryPhotos";

const MAX_PHOTOS = 12;
const AUTOPLAY_DELAY_MS = 4000;

/** Fisher-Yates — produces a uniform random permutation. */
function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export default function CommunityGalleryClient({ photos }: { photos: GalleryPhoto[] }) {
  // Shuffle on the client after mount — running shuffle() during SSR would
  // produce a different ordering than the client first paint and trip a
  // hydration mismatch. The gallery is below-the-fold so the brief empty
  // render is invisible.
  const [shuffled, setShuffled] = useState<(GalleryPhoto & { alt: string })[]>([]);
  const [api, setApi] = useState<CarouselApi>();
  const [current, setCurrent] = useState(0);
  const plugin = useRef(Autoplay({ delay: AUTOPLAY_DELAY_MS, stopOnInteraction: true, playOnInit: false }));

  useEffect(() => {
    setShuffled(shuffle(photos.map((photo, index) => ({ ...photo, alt: galleryPhotoAlt(photo, index, photos.length) }))).slice(0, MAX_PHOTOS));
  }, [photos]);

  useEffect(() => {
    if (!api) return;
    setCurrent(api.selectedScrollSnap());
    api.on("select", () => setCurrent(api.selectedScrollSnap()));
  }, [api]);

  useEffect(() => {
    if (!api) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const autoplay = plugin.current;
    const update = () => { if (media.matches) autoplay.stop(); else autoplay.play(); };
    update();
    media.addEventListener("change", update);
    return () => { media.removeEventListener("change", update); autoplay.stop(); };
  }, [api]);

  if (shuffled.length === 0) return null;

  return (
    <section className="relative px-6 py-10">
      <div className="max-w-[40rem] mx-auto">
        <hr className="mx-auto mb-10 w-12 border-ink/40" />
        <div className="text-center mb-8">
          <h2 className="text-[1.6rem] leading-tight mb-2 text-forest">
            Community Moments
          </h2>
          <p className="text-[1.05rem] text-muted max-w-2xl mx-auto">
            Glimpses of our vibrant community in action
          </p>
        </div>

        <Carousel
          plugins={[plugin.current]}
          opts={{ align: "start", loop: true }}
          setApi={setApi}
          className="w-full"
          onMouseEnter={plugin.current.stop}
          onMouseLeave={() => { if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) plugin.current.reset(); }}
        >
          <CarouselContent className="-ml-2 md:-ml-4">
            {shuffled.map((photo) => (
              <CarouselItem
                key={photo.src}
                className="pl-2 md:pl-4 basis-full sm:basis-1/2"
              >
                <Card className="overflow-hidden rounded-sm border-0">
                  <div className="aspect-square relative">
                    <Image
                      src={photo.src}
                      alt={photo.alt}
                      fill
                      sizes="(min-width: 1024px) 33vw, (min-width: 768px) 50vw, 100vw"
                      className="object-cover"
                    />
                  </div>
                </Card>
              </CarouselItem>
            ))}
          </CarouselContent>
          <CarouselPrevious className="hidden md:flex" />
          <CarouselNext className="hidden md:flex" />
        </Carousel>

        <div className="flex justify-center mt-6 gap-2">
          {shuffled.map((photo, index) => (
            <button
              key={photo.src}
              className={`transition-colors ${
                index === current
                  ? "w-8 h-2 rounded-full bg-sage"
                  : "w-2 h-2 rounded-full bg-ink/20 hover:bg-ink/40"
              }`}
              aria-label={`Go to slide ${index + 1}`}
              onClick={() => api?.scrollTo(index)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
