"use client";

import { useEffect } from "react";

/**
 * Registers /sw.js so the door-code page is cached for offline use.
 * Server-rendered (no UI), no-ops in dev to avoid stale-cache headaches.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;

    const onLoad = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch((err) => {
          // Non-fatal; the app still works fine without offline support.
          console.warn("[SW] registration failed:", err);
        });
    };

    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad, { once: true });

    return () => window.removeEventListener("load", onLoad);
  }, []);

  return null;
}
