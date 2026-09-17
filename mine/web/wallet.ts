/** Wallet display helpers shared by the pages and the extension. Signing in lives in account.ts. */
export const shortAddress = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
