// The part of noVNC's RFB client the Desktop tab uses (core/rfb.js; the
// package ships no types). `urlOrChannel` may be any object with the
// WebSocket interface (desktop-wire.ts RfbChannel).
declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      urlOrChannel: string | object,
      options?: { shared?: boolean },
    )
    scaleViewport: boolean
    resizeSession: boolean
    clipViewport: boolean
    viewOnly: boolean
    focusOnClick: boolean
    background: string
    qualityLevel: number
    compressionLevel: number
    disconnect(): void
    focus(): void
    clipboardPasteFrom(text: string): void
  }
}
