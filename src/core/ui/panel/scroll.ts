/*
 * Fluent New Tab
 * Copyright (c) 2026 SnowMint
 * Licensed under the GNU General Public License v3.0 (GPL-3.0)
 */

const WHEEL_THRESHOLD = 24;
const WHEEL_IDLE_MS = 140;
const SCROLL_EXCLUSIONS = '.shortcuts-grid, .launcher-grid, .panel-nav';
const ACTIVE_POPUP = 'dialog[open], .modal-overlay.active, .settings-popup.active, .launcher-popup.active, #engineDropdown.active, .dropdown-menu.active';

export function hasActivePopup(): boolean {
  return document.querySelector(ACTIVE_POPUP) !== null;
}

export function bindPanelScroll(
  drawer: HTMLElement,
  isOpen: () => boolean,
  setOpen: (open: boolean) => void,
): (active: boolean) => void {
  let distance = 0;
  let lastWheel = -Infinity;
  let consumedDirection = 0;

  function onWheel(event: WheelEvent): void {
    if (event.defaultPrevented || event.ctrlKey || event.shiftKey) return;
    const { deltaMode, deltaX, deltaY, timeStamp } = event;
    if (Math.abs(deltaY) <= Math.abs(deltaX)) return;
    const direction = Math.sign(deltaY);

    if (timeStamp - lastWheel > WHEEL_IDLE_MS) {
      distance = 0;
      consumedDirection = 0;
    }
    lastWheel = timeStamp;
    if (direction === consumedDirection) return;

    const open = isOpen();
    const target = event.target instanceof Element ? event.target : null;
    if ((open ? deltaY > 0 : deltaY < 0) ||
      target?.closest(SCROLL_EXCLUSIONS) || hasActivePopup()) {
      distance = 0;
      return;
    }
    if (open) {
      const viewport = drawer.querySelector<HTMLElement>('.panel-view:not([hidden]) .panel-scroll:not([hidden])');
      if (viewport && viewport.scrollTop > 0) {
        distance = 0;
        return;
      }
    }

    let unit = 1;
    if (deltaMode === WheelEvent.DOM_DELTA_LINE) unit = 16;
    else if (deltaMode === WheelEvent.DOM_DELTA_PAGE) unit = window.innerHeight;
    if (Math.sign(distance) !== direction) distance = 0;
    distance += deltaY * unit;
    if (Math.abs(distance) < WHEEL_THRESHOLD) return;

    if (event.cancelable) event.preventDefault();
    distance = 0;
    consumedDirection = direction;
    setOpen(!open);
  }

  return (active) => {
    if (active) window.addEventListener('wheel', onWheel, { passive: false });
    else {
      window.removeEventListener('wheel', onWheel);
      distance = consumedDirection = 0;
      lastWheel = -Infinity;
    }
  };
}
