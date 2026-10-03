// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const mounted = vi.hoisted(() => vi.fn());
vi.mock("next/dynamic", () => ({ default: (_loader: unknown, options: { ssr: boolean }) => {
  expect(options.ssr).toBe(false);
  return (props: { planKey: string; autoStart: boolean }) => {
    mounted(props);
    return React.createElement("div", null, "Payment UI");
  };
} }));
import { CryptoSubscribeButton } from "../src/components/membership/CryptoSubscribeButton";
it("mounts the deferred payment UI only after choosing crypto and preserves the selected plan", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(CryptoSubscribeButton, { planKey: "member_2day" })));
    expect(mounted).not.toHaveBeenCalled();
    expect(host.textContent).toBe("Pay with crypto");
    await act(async () => host.querySelector("button")!.click());
    expect(mounted).toHaveBeenCalledWith({ planKey: "member_2day", autoStart: true });
    expect(host.textContent).toBe("Payment UI");
  } finally {
    await act(async () => root.unmount());
  }
});
