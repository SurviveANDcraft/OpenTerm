/** mammoth ships browser-only entry points without their own typings. */
declare module "mammoth/mammoth.browser" {
  interface ConvertResult {
    value: string;
    messages: unknown[];
  }
  const mammoth: {
    convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<ConvertResult>;
    extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<ConvertResult>;
  };
  export default mammoth;
}

/** Vite turns an image import into the hashed URL it publishes it under. */
declare module "*.png" {
  const url: string;
  export default url;
}
