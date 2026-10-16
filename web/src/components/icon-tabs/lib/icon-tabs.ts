import type { IconTabsIndicatorBox } from "../types/icon-tabs";

/** Strong deceleration, close to the `ease-emphasized` curve. */
export function easeOutQuint(progress: number): number {
  return 1 - (1 - progress) ** 5;
}

export function measureActiveTab(
  list: HTMLElement
): IconTabsIndicatorBox | null {
  const tab = list.querySelector<HTMLElement>('[role="tab"][data-active]');
  if (!tab) {
    return null;
  }
  return {
    left: tab.offsetLeft,
    top: tab.offsetTop,
    width: tab.offsetWidth,
    height: tab.offsetHeight,
  };
}

export function applyIndicatorBox(
  element: HTMLElement,
  box: IconTabsIndicatorBox
) {
  element.style.transform = `translate(${box.left}px, ${box.top}px)`;
  element.style.width = `${box.width}px`;
  element.style.height = `${box.height}px`;
}
