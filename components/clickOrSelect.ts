'use client';

import { useCallback, useEffect, useRef, type MouseEvent } from 'react';

/**
 * How long a first click waits to see whether it is the start of a double-click.
 * A double-click selects a word, so it must not also toggle; the cost is that a
 * plain mouse click toggles this much later than it would otherwise.
 */
const DOUBLE_CLICK_WAIT_MS = 250;

/** True when the user has just drag-selected text inside `el`. */
function hasSelectionIn(el: Element): boolean {
  const sel = typeof window === 'undefined' ? null : window.getSelection();
  if (!sel || sel.isCollapsed || sel.toString().trim() === '') return false;
  return el.contains(sel.anchorNode) || el.contains(sel.focusNode);
}

/**
 * Returns a click handler that runs `action` for a plain click but not when the
 * click finishes a drag-select or is part of a double/triple-click, so text in a
 * clickable area stays copyable.
 *
 * Keyboard activation (Enter/Space on a button or <summary>) reports
 * `event.detail === 0` and runs at once. The handler also calls
 * `preventDefault()` on mouse clicks, which stops a <summary> toggling natively
 * so `action` can decide.
 */
export function useClickOrSelect(action: (el: HTMLElement) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionRef = useRef(action);
  actionRef.current = action;

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return useCallback((e: MouseEvent<HTMLElement>) => {
    const el = e.currentTarget;
    if (e.detail === 0) {
      actionRef.current(el);
      return;
    }
    e.preventDefault();
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    // The second click of a double-click cancels the first one's pending toggle.
    if (e.detail > 1 || hasSelectionIn(el)) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      if (!hasSelectionIn(el)) actionRef.current(el);
    }, DOUBLE_CLICK_WAIT_MS);
  }, []);
}
