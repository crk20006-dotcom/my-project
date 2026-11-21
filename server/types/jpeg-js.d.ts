declare module 'jpeg-js' {
  export interface RawImageData<T> {
    width: number;
    height: number;
    data: T;
  }

  export function decode(
    jpegData: ArrayBufferView | ArrayBuffer,
    opts?: {
      useTArray?: boolean;
      colorTransform?: boolean;
      formatAsRGBA?: boolean;
      tolerantDecoding?: boolean;
      maxResolutionInMP?: number;
      maxMemoryUsageInMB?: number;
    }
  ): RawImageData<Uint8Array>;
}
