export const IS_SAFARI = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
export const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
export const IS_MOBILE_SAFARI = IS_SAFARI && IS_IOS;
/** macOS and iOS, where Cmd plays the part of Ctrl. */
export const IS_MAC = /Macintosh|Mac OS X|iPad|iPhone|iPod/.test(navigator.userAgent);
export const IS_MOBILE =
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 0 && /Mobi|Android/i.test(navigator.userAgent));

/**
 * Safari has a bug where foreignObjects don't visually update when their parent's
 * transform changes. This function forces a redraw by removing and re-adding them.
 * Works on mobile Safari but not reliably on desktop Safari.
 */
export function redrawForeignObject(fo: SVGForeignObjectElement) {
  const parent = fo.parentNode;
  if (parent === null) {
    throw new Error("Cannot redraw a foreignObject that is not attached to the DOM");
  }
  parent.removeChild(fo);
  parent.appendChild(fo);
}

export function setupBrowserCompat(_root: HTMLDivElement) {
  // No browser-specific setup needed currently
}
