// The two small primitives the client is made of: a value that tells its readers when it changes,
// and a list of listeners.

import type { Signal } from "./client-interface.js";

export interface WritableSignal<T> extends Signal<T> {
  set(value: T): void;
  /** Changes the value without telling anyone; `notify` tells them. */
  setSilent(value: T): void;
  notify(): void;
}

export function signal<T>(initial: T): WritableSignal<T> {
  let value = initial;
  const subs = new Set<(v: T) => void>();
  const notify = () => {
    for (const cb of [...subs]) cb(value);
  };
  return {
    get: () => value,
    subscribe(cb) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    set(v) {
      if (v === value) return;
      value = v;
      notify();
    },
    setSilent(v) {
      value = v;
    },
    notify,
  };
}

export interface Emitter<T> {
  emit(value: T): void;
  /** Answers true when `cb` is the first listener. */
  add(cb: (value: T) => void): boolean;
  /** Answers true when `cb` was the last listener. */
  remove(cb: (value: T) => void): boolean;
  size(): number;
}

export function emitter<T>(): Emitter<T> {
  const subs = new Set<(v: T) => void>();
  return {
    emit(v) {
      for (const cb of [...subs]) cb(v);
    },
    add(cb) {
      subs.add(cb);
      return subs.size === 1;
    },
    remove(cb) {
      return subs.delete(cb) && subs.size === 0;
    },
    size: () => subs.size,
  };
}
