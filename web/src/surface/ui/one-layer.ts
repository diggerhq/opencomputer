// Escape closes this layer only (R19): the surface's own Escape never sees it.
export const oneLayer = (e: KeyboardEvent) => e.stopPropagation()
