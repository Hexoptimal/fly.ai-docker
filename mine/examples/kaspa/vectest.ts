// Quick check of khh.ts against rusty-kaspa's own test vectors (vectors.json, extracted from its matrix.rs tests).
import { readFileSync } from "node:fs";
import { generateMatrix, matrixHash } from "./khh.ts";
const v = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
const nibbles = (s: string) => Uint8Array.from([...s].map((c) => parseInt(c, 16)));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const got = matrixHash(nibbles(v.heavy.matrix), unhex(v.heavy.input));
console.log(`heavy_hash vector: ${hex(got) === v.heavy.expected ? "ok" : `FAIL got ${hex(got)} want ${v.heavy.expected}`}`);
const mine = generateMatrix(new Uint8Array(32).fill(42));
const want = nibbles(v.generate42.matrix);
console.log(`generate(matrix of 42s): ${mine.every((x, i) => x === want[i]) ? "ok" : "FAIL"}`);
