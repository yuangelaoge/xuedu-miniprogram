declare module "node:crypto" {
  export function createHmac(algorithm: string, key: Uint8Array): { update(data: string): { digest(encoding: string): string } };
  export function randomUUID(): string;
  export function scryptSync(password: string, salt: Uint8Array, keylen: number, options: { N: number; r: number; p: number; maxmem: number }): Uint8Array;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}
declare const Buffer: { from(data: string, encoding: string): Uint8Array & { length: number } };
