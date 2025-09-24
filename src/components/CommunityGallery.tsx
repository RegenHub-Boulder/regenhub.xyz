import React, { useState, useEffect } from "react";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  type CarouselApi,
} from "@/components/ui/carousel";
import { Card } from "@/components/ui/card";
import Autoplay from "embla-carousel-autoplay";

// Import all photos from the regenhubphotos folder
const photoModules = import.meta.glob(
  "/src/assets/regenhubphotos/*.{jpg,jpeg,png,webp}",
  {
    eager: true,
    as: "url",
  },
);

const CommunityGallery = () => {
  const [photos, setPhotos] = useState<string[]>([]);
  const [api, setApi] = useState<CarouselApi>();
  const [current, setCurrent] = useState(0);
  const plugin = React.useRef(
    Autoplay({ delay: 4000, stopOnInteraction: true }),
  );

  useEffect(() => {
    // Convert the imported modules to an array of photo URLs and shuffle them
    const photoUrls = Object.values(photoModules);

    // Fisher-Yates shuffle for true randomization
    const shuffled = [...photoUrls];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // Limit to 12 photos for better performance
    setPhotos(shuffled.slice(0, 12));
  }, []);

  useEffect(() => {
    if (!api) {
      return;
    }

    setCurrent(api.selectedScrollSnap());

    api.on("select", () => {
      setCurrent(api.selectedScrollSnap());
    });
  }, [api]);

  if (photos.length === 0) {
    return null;
  }

  return (
    <section className="relative px-6 py-16">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-4xl font-bold mb-4 text-forest">
            Community Moments
          </h2>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Glimpses of our vibrant community in action
          </p>
        </div>

        <Carousel
          plugins={[plugin.current]}
          opts={{
            align: "start",
            loop: true,
          }}
          setApi={setApi}
          className="w-full"
          onMouseEnter={plugin.current.stop}
          onMouseLeave={plugin.current.reset}
        >
          <CarouselContent className="-ml-2 md:-ml-4">
            {photos.map((photo) => (
              <CarouselItem
                key={photo}
                className="pl-2 md:pl-4 basis-full md:basis-1/2 lg:basis-1/3"
              >
                <Card className="glass-panel hover-lift overflow-hidden">
                  <div className="aspect-square relative">
                    <img
                      src={photo}
                      alt="Community moment"
                      className="absolute inset-0 w-full h-full object-cover"
                      loading="lazy"
                    />
                  </div>
                </Card>
              </CarouselItem>
            ))}
          </CarouselContent>
          <CarouselPrevious className="hidden md:flex" />
          <CarouselNext className="hidden md:flex" />
        </Carousel>

        {/* Auto-play indicator */}
        <div className="flex justify-center mt-6 gap-2">
          {photos.map((photo, index) => (
            <button
              key={photo}
              className={`transition-all ${
                index === current
                  ? "w-8 h-2 rounded-full bg-primary"
                  : "w-2 h-2 rounded-full bg-secondary/30 hover:bg-secondary/50"
              }`}
              aria-label={`Go to slide ${index + 1}`}
              onClick={() => api?.scrollTo(index)}
            />
          ))}
        </div>
      </div>
    </section>
  );
};

export default CommunityGallery;
