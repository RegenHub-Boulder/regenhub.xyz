// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("next/link", () => ({ default: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => React.createElement("a", props) }));
import { MobileNav } from "../src/components/nav/MobileNav";
let root: Root;
let host: HTMLDivElement;
let desktop = false;
let mediaChange: (() => void) | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  desktop = false;
  mediaChange = undefined;
  vi.stubGlobal("matchMedia", () => ({ get matches() { return desktop; }, addEventListener: (_: string, fn: () => void) => { mediaChange = fn; }, removeEventListener: vi.fn() }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.body.style.overflow = ""; vi.unstubAllGlobals(); });
async function render(element: React.ReactElement) { await act(async () => root.render(element)); }
async function click(element: Element) { await act(async () => (element as HTMLElement).click()); }
async function key(value: string, shiftKey = false) {
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true })));
}
it("opens a modal, focuses inside, cycles Tab, closes on Escape and restores focus", async () => {
  await render(React.createElement(MobileNav, { links: [{ href: "/about", label: "About" }] }));
  const trigger = document.querySelector('[aria-label="Open menu"]') as HTMLElement;
  trigger.focus(); await click(trigger);
  const close = document.querySelector('[aria-label="Close menu"]') as HTMLElement;
  expect(document.activeElement).toBe(close);
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  const links = dialog.querySelectorAll("a, button");
  (links[links.length - 1] as HTMLElement).focus(); await key("Tab");
  expect(document.activeElement).toBe(links[0]);
  await key("Tab", true); expect(document.activeElement).toBe(links[links.length - 1]);
  await key("Escape"); expect(document.activeElement).toBe(trigger);
  expect(dialog.hasAttribute("inert")).toBe(true);
});
it("makes the background inert and releases it and scroll lock on desktop resize", async () => {
  await render(React.createElement(MobileNav, { links: [] }));
  await click(document.querySelector('[aria-label="Open menu"]')!);
  expect(host.hasAttribute("inert")).toBe(true);
  expect(document.body.style.overflow).toBe("hidden");
  await act(async () => { desktop = true; mediaChange?.(); });
  expect(host.hasAttribute("inert")).toBe(false);
  expect(document.body.style.overflow).toBe("");
  expect(document.querySelector('[role="dialog"]')?.hasAttribute("inert")).toBe(true);
});
it("uses distinct dialog IDs for two instances", async () => {
  await render(React.createElement(React.Fragment, null,
    React.createElement(MobileNav, { links: [] }), React.createElement(MobileNav, { links: [] })));
  const triggers = [...host.querySelectorAll('[aria-label="Open menu"]')];
  const ids = triggers.map(t => t.getAttribute("aria-controls"));
  expect(new Set(ids).size).toBe(2);
  for (const id of ids) expect(document.getElementById(id!)?.getAttribute("role")).toBe("dialog");
});
it("hands overlapping menus to one owner without releasing background or losing focus", async () => {
  document.body.style.overflow = "clip";
  const navs = (first: boolean) => React.createElement(React.Fragment, null,
    first && React.createElement(MobileNav, { key: "first", links: [] }),
    React.createElement(MobileNav, { key: "second", links: [] }));
  await render(navs(true));
  const triggers = [...host.querySelectorAll('[aria-label="Open menu"]')] as HTMLElement[];
  await click(triggers[0]);
  // Programmatic overlap simulates two open requests despite inert background.
  await click(triggers[1]);
  expect(document.querySelectorAll('[aria-modal="true"]').length).toBe(1);
  const dialog = document.querySelector('[aria-modal="true"]')!;
  expect(dialog.closest('[inert]')).toBeNull();
  expect(dialog.contains(document.activeElement)).toBe(true);
  await render(navs(false));
  expect(host.hasAttribute("inert")).toBe(true);
  expect(document.body.style.overflow).toBe("hidden");
  await key("Escape");
  expect(document.activeElement).toBe(triggers[1]);
  expect(host.hasAttribute("inert")).toBe(false);
  expect(document.body.style.overflow).toBe("clip");
  document.body.style.overflow = "";
});
it("keeps the initially closed drawer inert and hidden from assistive technology", async () => {
  await render(React.createElement(MobileNav, { links: [{ href: "/about", label: "About" }] }));
  const trigger = host.querySelector('[aria-label="Open menu"]')!;
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  const dialog = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  expect(dialog.hasAttribute("inert")).toBe(true);
  expect(dialog.getAttribute("aria-hidden")).toBe("true");
});
