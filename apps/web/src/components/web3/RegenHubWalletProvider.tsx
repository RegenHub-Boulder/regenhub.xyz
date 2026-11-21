"use client";

import { useState, type ReactNode } from "react";
import {
  RainbowKitProvider,
  lightTheme,
  getDefaultConfig,
} from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { optimism } from "wagmi/chains";

const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim();
const projectId = walletConnectProjectId || "walletconnect-not-configured";

const wallets = [metaMaskWallet, coinbaseWallet, injectedWallet];
if (walletConnectProjectId) wallets.push(walletConnectWallet);

export const regenHubWalletConfig = getDefaultConfig({
  appName: "RegenHub Boulder",
  appDescription: "Pay RegenHub membership dues directly to the cooperative treasury.",
  appUrl: "https://regenhub.xyz",
  projectId,
  chains: [optimism],
  ssr: true,
  wallets: [{
    groupName: walletConnectProjectId ? "Choose a wallet" : "Installed wallets",
    wallets,
  }],
});

// The wallet sheet in the book's colours: ink buttons on paper (globals.css :root).
const theme = lightTheme({
  accentColor: "#27231d",
  accentColorForeground: "#f4efe3",
  borderRadius: "small",
  fontStack: "system",
  overlayBlur: "none",
});

export function RegenHubWalletProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={regenHubWalletConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          initialChain={optimism}
          modalSize="compact"
          theme={theme}
          appInfo={{
            appName: "RegenHub Boulder",
            learnMoreUrl: "https://regenhub.xyz",
          }}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
