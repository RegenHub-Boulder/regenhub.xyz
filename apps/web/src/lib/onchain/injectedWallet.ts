export type EthereumProvider = {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  isMetaMask?: boolean;
  isCoinbaseWallet?: boolean;
  isBraveWallet?: boolean;
  isRabby?: boolean;
};

export type InjectedWallet = {
  id: string;
  name: string;
  rdns: string;
  provider: EthereumProvider;
};

type Eip6963Detail = {
  info: { uuid: string; name: string; rdns: string };
  provider: EthereumProvider;
};

const REMEMBERED_WALLET_KEY = "regenhub.injected-wallet-rdns";

function legacyWallet(provider: EthereumProvider, index: number): InjectedWallet {
  if (provider.isRabby) {
    return { id: `legacy:rabby:${index}`, name: "Rabby Wallet", rdns: "io.rabby", provider };
  }
  if (provider.isBraveWallet) {
    return { id: `legacy:brave:${index}`, name: "Brave Wallet", rdns: "com.brave.wallet", provider };
  }
  if (provider.isCoinbaseWallet) {
    return { id: `legacy:coinbase:${index}`, name: "Coinbase Wallet", rdns: "com.coinbase.wallet", provider };
  }
  if (provider.isMetaMask) {
    return { id: `legacy:metamask:${index}`, name: "MetaMask", rdns: "io.metamask", provider };
  }
  return { id: `legacy:injected:${index}`, name: "Browser wallet", rdns: `injected.${index}`, provider };
}

/**
 * Discover every injected wallet without trusting the contested
 * `window.ethereum` slot. EIP-6963 is authoritative; the legacy providers
 * array remains as a fallback for older extensions.
 */
export async function discoverInjectedWallets(waitMs = 100): Promise<InjectedWallet[]> {
  const discovered: InjectedWallet[] = [];
  const seen = new Set<EthereumProvider>();
  const announce = (event: Event) => {
    const detail = (event as CustomEvent<Eip6963Detail>).detail;
    if (!detail?.provider || !detail.info || seen.has(detail.provider)) return;
    seen.add(detail.provider);
    discovered.push({
      id: detail.info.uuid,
      name: detail.info.name,
      rdns: detail.info.rdns,
      provider: detail.provider,
    });
  };

  window.addEventListener("eip6963:announceProvider", announce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  window.removeEventListener("eip6963:announceProvider", announce);

  const ethereum = (window as unknown as {
    ethereum?: EthereumProvider & { providers?: EthereumProvider[] };
  }).ethereum;
  const legacyProviders = ethereum?.providers?.length ? ethereum.providers : ethereum ? [ethereum] : [];
  for (const [index, provider] of legacyProviders.entries()) {
    if (seen.has(provider)) continue;
    seen.add(provider);
    discovered.push(legacyWallet(provider, index));
  }

  return discovered.sort((a, b) => a.name.localeCompare(b.name));
}

export function rememberInjectedWallet(wallet: InjectedWallet) {
  try {
    window.sessionStorage.setItem(REMEMBERED_WALLET_KEY, wallet.rdns);
  } catch {
    // Wallet selection still works when storage is unavailable.
  }
}

export function rememberedInjectedWallet(wallets: InjectedWallet[]): InjectedWallet | null {
  try {
    const rdns = window.sessionStorage.getItem(REMEMBERED_WALLET_KEY);
    return wallets.find((wallet) => wallet.rdns === rdns) ?? null;
  } catch {
    return null;
  }
}
