// Following the end of a conversation as it grows, until the reader leaves it.

// The pane's position: how far down it is, and how tall its view is.
export type Seen = { top: number; bottom: number; view: number }

export const at = (el: HTMLElement): Seen => ({
  top: el.scrollTop,
  bottom: el.scrollHeight - el.scrollTop - el.clientHeight,
  view: el.clientHeight,
})

// Whether the pane keeps following the end, from where it was to where it is.
// Any move up by the reader leaves the end, however small: a trackpad moves a
// few pixels at a time, and a distance from the end would snap each one back
// on the next render. Content growing below does not move the top, content
// shrinking clamps it at the end, and a resizing view is not the reader.
// Moving down to near the end, or reaching it, follows it again.
export function following(was: boolean, from: Seen, to: Seen): boolean {
  if (to.view === from.view && to.top < from.top && to.bottom > 1) return false
  if (to.bottom <= 1 || (to.top > from.top && to.bottom < 24)) return true
  return was
}
