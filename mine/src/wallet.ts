/**
 * Proving a miner's wallet: Sign-In with Ethereum (EIP-4361) messages the server writes itself, checked by
 * recovering the signer from a personal_sign (EIP-191) signature. Keccak and secp256k1 come from the audited
 * @noble libraries; nothing here trusts text a client wrote.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** EIP-55 mixed-case checksum form. */
export function checksumAddress(address: string): string {
  if (!ADDRESS.test(address)) throw new Error(`not an address: ${address}`);
  const lower = address.slice(2).toLowerCase();
  const hash = hex(keccak_256(new TextEncoder().encode(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

/** keccak256("\x19Ethereum Signed Message:\n" + byte length + message), what personal_sign signs. */
export function personalMessageHash(message: string): Uint8Array {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const all = new Uint8Array(prefix.length + body.length);
  all.set(prefix);
  all.set(body, prefix.length);
  return keccak_256(all);
}

/** The checksummed address that signed `message` with personal_sign; throws on a malformed signature. */
export function recoverAddress(message: string, signature: string): string {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("signature must be 65 bytes of hex");
  const bytes = Buffer.from(signature.slice(2), "hex");
  const v = bytes[64];
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) throw new Error(`bad recovery byte ${v}`);
  // wallets give r || s || v; noble's "recovered" format is recovery || r || s
  const recovered = new Uint8Array(65);
  recovered[0] = recovery;
  recovered.set(bytes.subarray(0, 64), 1);
  const point = secp256k1.Signature.fromBytes(recovered, "recovered").recoverPublicKey(personalMessageHash(message));
  const uncompressed = point.toBytes(false); // 0x04 || x || y
  return checksumAddress(`0x${hex(keccak_256(uncompressed.subarray(1))).slice(-40)}`);
}

export interface SiweFields {
  /** host the user is signing in to, e.g. flyai-mine.fly.dev */
  domain: string;
  address: string;
  statement: string;
  uri: string;
  chainId: number;
  nonce: string;
  issuedAt: Date;
  expirationTime: Date;
}

/** An EIP-4361 message, exactly as wallets expect to display it. */
export function siweMessage(f: SiweFields): string {
  return [
    `${f.domain} wants you to sign in with your Ethereum account:`,
    checksumAddress(f.address),
    "",
    f.statement,
    "",
    `URI: ${f.uri}`,
    "Version: 1",
    `Chain ID: ${f.chainId}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt.toISOString()}`,
    `Expiration Time: ${f.expirationTime.toISOString()}`,
  ].join("\n");
}
