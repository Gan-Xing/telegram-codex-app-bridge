declare module 'qrcode-terminal' {
  interface QrCodeTerminal {
    generate(data: string, options?: { small?: boolean }): void;
  }
  const qrcode: QrCodeTerminal;
  export default qrcode;
}
