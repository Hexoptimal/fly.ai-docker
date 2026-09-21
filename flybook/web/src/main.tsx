import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import App from "./App";
import { init } from "./i18n";
import { wagmiConfig } from "./wallet";
import common from "../../../docs/assets/i18n/en/common.json";
import flybook from "../../../docs/assets/i18n/en/flybook.json";
import "./styles.css";

const queryClient = new QueryClient();

// the page's language first (English is bundled; others come from the site's /assets/i18n/), then the app
init({ ns: ["common", "flybook"], bundled: { common, flybook }, base: "/assets/i18n/" }).finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </WagmiProvider>
    </StrictMode>,
  );
});
