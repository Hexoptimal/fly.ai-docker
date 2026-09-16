/** Load the `flybrain export --web` files from disk (Node only). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { buildModel, type Model } from "./model.ts";

const unpack = (b: Buffer): ArrayBuffer => {
  const raw = b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b;
  return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
};

export function loadModel(dir: string): Model {
  const info: { parts: string[] } = JSON.parse(readFileSync(join(dir, "brain.json"), "utf8"));
  const meta = unpack(readFileSync(join(dir, "meta.bin")));
  const weights = unpack(Buffer.concat(info.parts.map((p) => readFileSync(join(dir, p)))));
  return buildModel(meta, weights);
}
