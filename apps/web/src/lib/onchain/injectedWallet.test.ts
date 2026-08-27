import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverInjectedWallets,
  rememberInjectedWallet,
  rememberedInjectedWallet,
  type EthereumProvider,
  type InjectedWallet,
} from "./injectedWallet";

type TestWindow = EventTarget & {
  ethereum?: EthereumProvider & { providers?: EthereumProvider[] };
  sessionStorage: Storage;
};

const originalWindow = globalThis.window;

function provider(flags: Partial<EthereumProvider> = {}): EthereumProvider {
  return { request: vi.fn(), ...flags };
}

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function installWindow(ethereum?: TestWindow["ethereum"]): TestWindow {
  const target = new EventTarget() as TestWindow;
  target.ethereum = ethereum;
  target.sessionStorage = storage();
  vi.stubGlobal("window", target);
  return target;
}

function announce(target: EventTarget, detail: unknown) {
  const event = new Event("eip6963:announceProvider") as Event & { detail: unknown };
  event.detail = detail;
  target.dispatchEvent(event);
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalWindow) vi.stubGlobal("window", originalWindow);
});

describe("injected wallet discovery", () => {
  it("returns each EIP-6963 wallet instead of trusting the contested window.ethereum slot", async () => {
    const coinbase = provider({ isCoinbaseWallet: true });
    const metamask = provider({ isMetaMask: true });
    const target = installWindow(coinbase);
    target.addEventListener("eip6963:requestProvider", () => {
      announce(target, { info: { uuid: "coinbase", name: "Coinbase Wallet", rdns: "com.coinbase.wallet" }, provider: coinbase });
      announce(target, { info: { uuid: "metamask", name: "MetaMask", rdns: "io.metamask" }, provider: metamask });
    });

    const wallets = await discoverInjectedWallets(0);

    expect(wallets.map(({ name }) => name)).toEqual(["Coinbase Wallet", "MetaMask"]);
    expect(wallets.find(({ name }) => name === "MetaMask")?.provider).toBe(metamask);
  });

  it("falls back to the legacy providers array and identifies MetaMask and Coinbase", async () => {
    const coinbase = provider({ isCoinbaseWallet: true });
    const metamask = provider({ isMetaMask: true });
    installWindow(Object.assign(coinbase, { providers: [coinbase, metamask] }));

    const wallets = await discoverInjectedWallets(0);

    expect(wallets.map(({ name }) => name)).toEqual(["Coinbase Wallet", "MetaMask"]);
  });

  it("remembers the exact wallet chosen for the portal payment handoff", () => {
    installWindow();
    const wallets: InjectedWallet[] = [
      { id: "coinbase", name: "Coinbase Wallet", rdns: "com.coinbase.wallet", provider: provider() },
      { id: "metamask", name: "MetaMask", rdns: "io.metamask", provider: provider() },
    ];

    rememberInjectedWallet(wallets[1]);

    expect(rememberedInjectedWallet(wallets)).toBe(wallets[1]);
  });
});
