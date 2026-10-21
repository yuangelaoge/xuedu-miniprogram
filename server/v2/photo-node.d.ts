declare module "node:url" {
  export class URL {
    constructor(value: string);
    protocol: string; hostname: string; username: string; password: string;
    port: string; hash: string; href: string; pathname: string;
  }
}
declare module "node:buffer" {
  export interface Buffer extends Uint8Array {
    subarray(start?:number,end?:number):Buffer;
    equals(other:Uint8Array):boolean;
    toString(encoding?:string):string;
  }
  export const Buffer: {
    from(value:readonly number[] | Uint8Array):Buffer;
    concat(values:readonly Uint8Array[]):Buffer;
  };
}
