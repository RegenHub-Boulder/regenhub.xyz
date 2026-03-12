"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import forestMascot from "@/assets/forest-mascot.png";

const MASCOT_SAYINGS = [
  "Scenius emerges! \ud83c\udf3f",
  "Collective genius activated! \u2728",
  "1 + 1 = 11 here! \ud83d\ude80",
  "We build the future together! \ud83d\udc9a",
  "Ideas compound daily! \ud83e\udde0",
  "Innovation through cooperation! \ud83e\udd1d",
  "Regenerating community wealth! \ud83c\udf31",
  "Aligned action creates magic! \u26a1",
  "Your potential amplified! \ud83c\udfaf",
  "Together we go far! \ud83c\udf0d",
];

export function ForestMascot() {
  const [mascotX, setMascotX] = useState(-200);
  const [mascotDir, setMascotDir] = useState(1);
  const [mascotClicks, setMascotClicks] = useState(0);
  const [scrollOpacity, setScrollOpacity] = useState(1);

  useEffect(() => {
    const id = setInterval(() => {
      setMascotX((x) => {
        const w = window.innerWidth;
        const nx = x + 2 * mascotDir;
        if (nx > w) return -200;
        if (nx < -200) return w;
        return nx;
      });
    }, 50);
    return () => clearInterval(id);
  }, [mascotDir]);

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      if (y <= 50) setScrollOpacity(1);
      else if (y >= 300) setScrollOpacity(0);
      else setScrollOpacity(1 - (y - 50) / 250);
    };
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div
      className="fixed hidden lg:block z-50 cursor-pointer"
      style={{
        left: `${mascotX}px`,
        bottom: "60px",
        transform: `scaleX(${mascotDir})`,
        opacity: scrollOpacity,
        pointerEvents: scrollOpacity === 0 ? "none" : "auto",
        transition: "opacity 0.3s",
      }}
      onClick={() => {
        setMascotDir((d) => d * -1);
        setMascotClicks((c) => c + 1);
      }}
    >
      <Image
        src={forestMascot}
        alt="RegenHub Mascot"
        width={128}
        height={128}
        className="animate-hop opacity-80 hover:opacity-100 hover:scale-110 transition-all duration-300"
      />
      {mascotClicks > 0 && (
        <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-white/90 px-3 py-1 rounded-full text-sm font-medium whitespace-nowrap shadow-lg text-forest">
          {MASCOT_SAYINGS[mascotClicks % MASCOT_SAYINGS.length]}
        </div>
      )}
    </div>
  );
}
