"use client";

import { createContext, useContext } from "react";

/**
 * True while an admin views the portal as someone else (lib/viewAs.ts). Buttons that would change something read it
 * and render disabled, titled "Read-only preview"; the server refuses the write anyway (src/proxy.ts).
 */
const PreviewContext = createContext(false);

export function PreviewProvider({ children }: { children: React.ReactNode }) {
  return <PreviewContext.Provider value={true}>{children}</PreviewContext.Provider>;
}

export function usePreview(): boolean {
  return useContext(PreviewContext);
}

export const PREVIEW_TITLE = "Read-only preview";
