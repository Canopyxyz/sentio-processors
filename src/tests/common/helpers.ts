import { Address } from "./types.js";

export function generateRandomAddress(): Address {
  const bytes = new Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  const hexString = Buffer.from(bytes).toString("hex");
  return `0x${hexString}`;
}

export function secondsToMicros(seconds: number | bigint): bigint {
  return BigInt(seconds) * 1_000_000n;
}
