/**
 * Feeding a paid order's results to the buyer as miners settle them. Three ways, all over the same rows:
 *
 *  - pull:    GET /api/orders/:id/results?after=<seq>, a page of rows settled after `seq`, and `next` to ask with
 *  - stream:  GET /api/orders/:id/stream?after=<seq>, server-sent events: `result` per row, `status` as it changes
 *  - webhook: the order's https URL gets POSTs of up to WEBHOOK_BATCH rows, signed with the order's secret,
 *             retried with backoff until the URL answers 2xx; a last POST carries the final status
 *
 * Every settled row has a `seq` that only grows, so a buyer who keeps the last one seen never misses or repeats a row.
 *
 * Webhook signature: header `X-Flyai-Signature: t=<unix ms>,v1=<hex>` where hex = HMAC-SHA256(secret, `${t}.${body}`).
 * Check it against the raw body and reject old timestamps.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const WEBHOOK_BATCH = 500;

/** A private, loopback, link-local or otherwise internal address, which a webhook must not reach. */
export function internalAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const x = ip.toLowerCase();
  return x === "::" || x === "::1" || x.startsWith("fc") || x.startsWith("fd") || /^fe[89ab]/.test(x) || x.startsWith("ff");
}

/**
 * The URL a webhook may be sent to: https, no credentials, and a host that resolves only to public addresses.
 * `allowInternal` (tests) also lets http and internal hosts through.
 */
export async function checkWebhook(raw: string, allowInternal = false): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("webhook must be a URL");
  }
  if (raw.length > 500) throw new Error("webhook URL is too long");
  if (url.protocol !== "https:" && !(allowInternal && url.protocol === "http:")) throw new Error("webhook must be https");
  if (url.username || url.password) throw new Error("webhook URL can't carry credentials");
  if (allowInternal) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw new Error(`webhook host ${host} doesn't resolve`);
  }
  if (!addresses.length || addresses.some(internalAddress)) throw new Error("webhook must point at a public address");
  return url;
}

export function sign(secret: string, body: string, at = Date.now()): string {
  return `t=${at},v1=${createHmac("sha256", secret).update(`${at}.${body}`).digest("hex")}`;
}

/** What a receiver does: true if `header` signs `body` with `secret` and is younger than `maxAgeMs`. */
export function verify(secret: string, body: string, header: string, maxAgeMs = 5 * 60_000): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!m || Math.abs(Date.now() - Number(m[1])) > maxAgeMs) return false;
  const want = createHmac("sha256", secret).update(`${m[1]}.${body}`).digest();
  return timingSafeEqual(want, Buffer.from(m[2], "hex"));
}

/** Delay before retry n (1-based): 10 s doubling, at most an hour. */
export const backoffMs = (fails: number): number => Math.min(3_600_000, 10_000 * 2 ** Math.max(0, fails - 1));

/** Retries before a webhook is given up on (about two days at the cap); the results stay pullable. */
export const WEBHOOK_MAX_FAILS = 60;
