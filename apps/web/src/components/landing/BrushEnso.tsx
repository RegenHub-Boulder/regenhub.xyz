import Image from "next/image";
import regenHubLogo from "@/assets/regenhub-logo.svg";

/**
 * The home page's one live moment: a brush circle (an ensō) drawn once around the mark as the page opens
 * (globals.css .enso; still under reduced motion). Drawn in SVG; the turbulence filter roughens the edge so it reads
 * as ink, not vector.
 */
export function BrushEnso() {
  return (
    <div className="relative mx-auto mb-5 aspect-square w-[clamp(6.5rem,20vw,8.5rem)] text-foreground" aria-hidden>
      <svg className="enso absolute inset-0 h-full w-full opacity-80" viewBox="0 0 200 200" focusable="false">
        <defs>
          <filter id="enso-ink" x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="4" />
            <feDisplacementMap in="SourceGraphic" scale="5" />
          </filter>
        </defs>
        <path
          pathLength={1}
          d="M150 52 C 120 22, 58 26, 38 72 C 20 114, 46 168, 100 172 C 150 176, 182 134, 170 92 C 164 72, 152 60, 140 54"
          fill="none"
          stroke="currentColor"
          strokeWidth="7"
          strokeLinecap="round"
          filter="url(#enso-ink)"
        />
      </svg>
      <Image
        src={regenHubLogo}
        alt=""
        width={58}
        height={51}
        priority
        className="absolute left-1/2 top-1/2 w-[3.2rem] -translate-x-1/2 -translate-y-[54%] opacity-90"
      />
    </div>
  );
}
