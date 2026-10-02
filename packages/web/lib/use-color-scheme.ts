"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the page is currently dark.
 *
 * Everything else in this app follows Tailwind's `dark:` variant and never needs to know
 * this. The code viewer is the exception: `@pierre/diffs` renders through Shiki and takes
 * a theme NAME as a string (`"github-dark"`), so it cannot participate in a CSS variant.
 * It has to be told, in JavaScript, which scheme is active.
 *
 * Two sources, because either can change without the other:
 *   - the `class` on <html>, which is how an explicit light/dark choice is expressed
 *   - the OS preference, which decides when no class is set
 *
 * `useSyncExternalStore` rather than an effect + state: the first render already gets the
 * right answer, so the viewer never paints a light theme and then flips.
 */

function isDark(): boolean {
  const root = document.documentElement;
  if (root.classList.contains("dark")) return true;
  if (root.classList.contains("light")) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["class"] });

  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onChange);

  return () => {
    observer.disconnect();
    media.removeEventListener("change", onChange);
  };
}

/** Shiki theme name for the current colour scheme. */
export function usePierreTheme(): "github-dark" | "github-light" {
  // The server snapshot is only reached if this ever renders on the server. It does not
  // today — the page is loaded through `dynamic(..., { ssr: false })` — but returning
  // light keeps it from throwing if that changes.
  const dark = useSyncExternalStore(subscribe, isDark, () => false);
  return dark ? "github-dark" : "github-light";
}
