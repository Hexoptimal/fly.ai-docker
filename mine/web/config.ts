/**
 * Where the compute pages find things. These are the local values: `npm start` serves the pages, the API and
 * the brain files from one origin. The Vercel build (mine/scripts/build-web.mjs) writes production ones:
 * pages on www.flyaiworld.com/compute/, the API on fly.io, the brain files from the Simulation.
 */
export const API = "";
export const CONNECTOME = "/connectome";
/** Reown (WalletConnect) project id: phones without a wallet browser connect through it. Empty offers browser wallets only. */
export const WALLETCONNECT_PROJECT_ID = "";
