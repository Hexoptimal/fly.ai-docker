/**
 * Coinbase Onramp (Coinbase Developer Platform): card buyers get USDC on Base straight into their wallet. The server
 * creates a single-use checkout link per purchase, authenticated with a CDP Secret API key (Ed25519): each request
 * carries a JWT signed for that exact method, host and path, valid two minutes.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "node:crypto";

const HOST = "api.cdp.coinbase.com";
const b64url = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");

export interface OnrampSession { url: string }

export class Cdp {
  private readonly keyId: string;
  private readonly seed: Uint8Array;

  constructor(keyId: string, secret: string) {
    keyId = keyId.trim(); // a stray carriage return from a Windows-edited env file breaks the signature
    const raw = Buffer.from(secret.trim(), "base64");
    // an Ed25519 secret key: 32 bytes of seed, then the 32-byte public key
    if (raw.length !== 64) throw new Error("CDP_API_KEY_SECRET must be an Ed25519 secret key (64 bytes, base64)");
    this.keyId = keyId;
    this.seed = Uint8Array.from(raw.subarray(0, 32));
  }

  private jwt(method: string, path: string): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "EdDSA", kid: this.keyId, typ: "JWT", nonce: randomBytes(8).toString("hex") };
    const payload = { sub: this.keyId, iss: "cdp", aud: ["cdp_service"], nbf: now, exp: now + 120, uri: `${method} ${HOST}${path}` };
    const signing = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    return `${signing}.${b64url(ed25519.sign(new TextEncoder().encode(signing), this.seed))}`;
  }

  private async post(path: string, body: unknown): Promise<any> {
    const res = await fetch(`https://${HOST}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.jwt("POST", path)}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Coinbase ${res.status}: ${json.errorMessage ?? json.message ?? JSON.stringify(json)}`);
    return json;
  }

  /** A single-use checkout: buy `usdc` USDC with a card, delivered on Base to `wallet`, then back to `redirectUrl`. */
  async onramp(o: { wallet: string; usdc: string; redirectUrl?: string; clientIp?: string; partnerUserRef?: string; network?: string }): Promise<OnrampSession> {
    const json = await this.post("/platform/v2/onramp/sessions", {
      destinationAddress: o.wallet,
      destinationNetwork: o.network ?? "base",
      purchaseCurrency: "USDC",
      purchaseAmount: o.usdc,
      paymentCurrency: "USD",
      ...(o.redirectUrl ? { redirectUrl: o.redirectUrl } : {}),
      ...(o.clientIp ? { clientIp: o.clientIp } : {}),
      ...(o.partnerUserRef ? { partnerUserRef: o.partnerUserRef } : {}),
    });
    const url = json.session?.onrampUrl;
    if (!url) throw new Error(`Coinbase returned no checkout link: ${JSON.stringify(json).slice(0, 200)}`);
    return { url };
  }
}
