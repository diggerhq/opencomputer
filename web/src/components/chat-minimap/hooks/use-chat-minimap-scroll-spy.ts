"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type TurnRef = (element: HTMLElement | null) => void;

export const useChatMinimapScrollSpy = (turnCount: number) => {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState<ReadonlySet<number>>(new Set());
  const elements = useRef(new Map<number, HTMLElement>());
  const turnRefs = useRef(new Map<number, TurnRef>());

  useEffect(() => {
    if (!root) {
      return;
    }
    const indexes = new Map<Element, number>();
    const inView = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = indexes.get(entry.target);
          if (index === undefined) {
            continue;
          }
          if (entry.isIntersecting) {
            inView.add(index);
          } else {
            inView.delete(index);
          }
        }
        setVisible(new Set(inView));
      },
      { root }
    );
    for (const [index, element] of elements.current) {
      if (index < turnCount) {
        indexes.set(element, index);
        observer.observe(element);
      }
    }
    return () => observer.disconnect();
  }, [root, turnCount]);

  const turnRef = useCallback((index: number) => {
    const cached = turnRefs.current.get(index);
    if (cached) {
      return cached;
    }
    const ref: TurnRef = (element) => {
      if (element) {
        elements.current.set(index, element);
      } else {
        elements.current.delete(index);
      }
    };
    turnRefs.current.set(index, ref);
    return ref;
  }, []);

  const scrollToTurn = useCallback(
    (index: number) => {
      const element = elements.current.get(index);
      if (!(root && element)) {
        return;
      }
      root.scrollBy({
        behavior: "smooth",
        top:
          element.getBoundingClientRect().top -
          root.getBoundingClientRect().top,
      });
    },
    [root]
  );

  return { rootRef: setRoot, scrollToTurn, turnRef, visible };
};
