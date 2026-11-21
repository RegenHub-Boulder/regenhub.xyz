import Image from "next/image";
import { isStylePreviewEnabled } from "@/lib/stylePreview";
import regenHubLogo from "@/assets/regenhub-logo.svg";

/**
 * STAGING ONLY (T-482): the few things a direction adds that CSS alone can't draw. Each renders nothing unless the
 * preview switch is on (lib/stylePreview.ts), and app/style-directions.css shows it only under its own direction,
 * so production HTML is unchanged. All art here is drawn in SVG: no stock or generated imagery.
 */

/** "by Techne" beside the RegenHub wordmark: the umbrella, quietly, while RegenHub stays the name people know. */
export function ByTechne() {
  if (!isStylePreviewEnabled()) return null;
  return (
    <span data-direction-only="book field studio" className="rh-by-techne">
      by Techne
    </span>
  );
}

/** The art above the home page's title, per direction. */
export function HeroArt() {
  if (!isStylePreviewEnabled()) return null;
  return (
    <>
      <BrushEnso />
      <FlatironsPainting />
      <StudioPhoto />
    </>
  );
}

/** Studio: one real photograph of the place: the view west from the hub's roof to the Flatirons. */
function StudioPhoto() {
  return (
    <div data-direction-only="studio" className="rh-studio-photo">
      <Image
        src="/regenhubphotos/photo_5086941274224397424_y.jpg"
        alt="The view west from RegenHub's roof over Boulder to the Flatirons"
        width={1280}
        height={959}
        sizes="(min-width: 768px) 40vw, 100vw"
      />
    </div>
  );
}

/** Book: one brush circle (an ensō) drawn once around the mark as the page opens. */
function BrushEnso() {
  return (
    <div data-direction-only="book" className="rh-enso-wrap" aria-hidden>
      <svg className="rh-enso" viewBox="0 0 200 200" focusable="false">
        <defs>
          <filter id="rh-enso-ink" x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.9"
              numOctaves="2"
              seed="4"
            />
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
          filter="url(#rh-enso-ink)"
        />
      </svg>
      <Image
        src={regenHubLogo}
        alt=""
        width={72}
        height={72}
        className="rh-enso-mark"
      />
    </div>
  );
}

/** A ridge line of small irregular bumps (tree tops), the same on every render. */
function treeLine(y: number, amp: number, step: number, seed: number): string {
  let d = `M-20 340 L-20 ${y}`;
  let r = seed;
  for (let x = -20; x <= 1220; x += step) {
    r = (r * 9301 + 49297) % 233280;
    const h = amp * (0.35 + (r / 233280) * 0.65);
    d += ` Q${x + step / 2} ${(y - h).toFixed(1)} ${x + step} ${y}`;
  }
  return d + " L1220 340Z";
}

/**
 * Field: a painted view west from Boulder: the far range, Green Mountain, the Flatirons' tilted slabs, the pine
 * foothills and a meadow. Layers settle in from back to front. Edges are roughened with an SVG turbulence filter so
 * they read as brushed, not vector-clean.
 */
function FlatironsPainting() {
  const slabs = [
    "M462 238 C 478 182, 512 124, 548 92 C 570 132, 592 192, 606 238Z",
    "M586 242 C 606 170, 636 108, 668 80 C 694 122, 718 190, 734 242Z",
    "M712 246 C 728 198, 750 152, 774 130 C 792 160, 808 208, 822 246Z",
    "M814 248 C 824 222, 838 198, 852 186 C 862 206, 874 228, 882 248Z",
  ];
  return (
    <svg
      data-direction-only="field"
      className="rh-landscape"
      viewBox="0 0 1200 300"
      preserveAspectRatio="xMidYMax slice"
      role="img"
      aria-label="A painted view of the Flatirons above Boulder"
    >
      <defs>
        <filter id="rh-wash" x="-5%" y="-20%" width="110%" height="160%">
          <feTurbulence type="fractalNoise" baseFrequency="0.015 0.05" numOctaves="4" seed="7" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="10" />
        </filter>
        <filter id="rh-grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" seed="2" />
          <feColorMatrix values="0 0 0 0 0.3  0 0 0 0 0.28  0 0 0 0 0.2  0 0 0 0.08 0" />
        </filter>
        <linearGradient id="rh-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#dde3d3" />
          <stop offset="1" stopColor="#efe5cf" />
        </linearGradient>
      </defs>
      <rect width="1200" height="300" fill="url(#rh-sky)" />
      <g filter="url(#rh-wash)">
        <path
          className="rh-layer rh-layer-1"
          fill="#b3bcab"
          opacity="0.7"
          d="M-20 160 C 90 132, 170 146, 250 122 C 320 102, 390 124, 460 108 C 560 86, 900 96, 1000 118 C 1080 134, 1150 120, 1220 128 L1220 340 L-20 340Z"
        />
        <path
          className="rh-layer rh-layer-2"
          fill="#56694a"
          opacity="0.92"
          d="M120 340 L120 214 C 240 166, 380 110, 520 92 C 640 78, 770 98, 870 134 C 960 164, 1060 192, 1220 202 L1220 340Z"
        />
        <g className="rh-layer rh-layer-2">
          {slabs.map((d) => (
            <path key={d} d={d} fill="#a5673a" opacity="0.95" />
          ))}
          <g stroke="#7d4a28" strokeWidth="1.6" opacity="0.45" fill="none">
            <path d="M548 100 L536 236 M548 100 L574 236 M668 88 L654 240 M668 88 L700 240 M774 138 L762 244 M774 138 L796 244" />
          </g>
        </g>
        <path className="rh-layer rh-layer-3" fill="#3f5233" d={treeLine(246, 18, 14, 11)} />
        <path
          className="rh-layer rh-layer-3"
          fill="#9aa266"
          opacity="0.85"
          d="M-20 270 C 180 256, 340 272, 540 262 C 720 252, 900 270, 1080 260 C 1140 257, 1190 262, 1220 260 L1220 340 L-20 340Z"
        />
        <path className="rh-layer rh-layer-4" fill="#2f3d27" d={treeLine(288, 34, 22, 5)} />
      </g>
      <rect width="1200" height="300" filter="url(#rh-grain)" />
    </svg>
  );
}
