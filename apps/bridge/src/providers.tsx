import type { PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  InterwovenKitProvider,
  TESTNET,
  injectStyles,
} from "@initia/interwovenkit-react";
import InterwovenKitStyles from "@initia/interwovenkit-react/styles.js";
import { WagmiProvider, createConfig, http } from "wagmi";
import { sepolia } from "wagmi/chains";
import { SINERGY_LOCAL_CHAIN } from "@sinergy/shared";
import { buildInterwovenCustomChain, SINERGY_ROLLUP_CHAIN_ID } from "./initia";

injectStyles(InterwovenKitStyles);

const queryClient = new QueryClient();
const customChain = buildInterwovenCustomChain();
const interwovenKitProps = {
  ...TESTNET,
  defaultChainId: SINERGY_ROLLUP_CHAIN_ID,
  customChain,
  customChains: [customChain],
  theme: "dark",
} as const;

const wagmiConfig = createConfig({
  chains: [SINERGY_LOCAL_CHAIN, sepolia],
  transports: {
    [SINERGY_LOCAL_CHAIN.id]: http(SINERGY_LOCAL_CHAIN.rpcUrls.default.http[0]),
    [sepolia.id]: http(),
  },
});

export function Providers({ children }: PropsWithChildren) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <InterwovenKitProvider {...(interwovenKitProps as any)}>
          {children}
        </InterwovenKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
