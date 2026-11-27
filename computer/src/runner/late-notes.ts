// Notes for the model that no person wrote and that arrive on their own time:
// today, that an attachment's background download settled (attachments.ts
// `lateNote`). One goes in the way a message sent mid-turn does: into the
// running turn at its next tool boundary (a steer). With no turn running it
// waits for the next message and goes in with it, so a note never starts a
// turn nobody asked for. A note is the runner's word, not a message: the
// thread and the API's journal show nothing of it.

export class LateNotes {
  private held: string[] = [];

  constructor(
    private busy: () => boolean,
    /** Into the running turn, as a steer. */
    private steer: (note: string) => void,
  ) {}

  add(note: string) {
    if (this.busy()) this.steer(note);
    else this.held.push(note);
  }

  /** A message on its way to the model, with every note that waited for it. */
  with(text: string): string {
    return [text, ...this.held.splice(0)].filter(Boolean).join('\n');
  }
}
