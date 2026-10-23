// Where the three Winamp windows go for a given screen. Pure, so it can be
// tested without a browser (test/fit.test.mjs).
//
// The skin is a fixed-size bitmap, so the windows are zoomed as a block until
// they fill the screen. A tall screen gets one column (main, equalizer,
// playlist); a wide one (an iPhone Duo opened out, a phone on its side) gets
// two, with the playlist beside the other two. Whichever draws the skin bigger
// wins. Width and height both limit the zoom: an iPhone Duo goes from 382x580
// to 951x543 without reloading the page.

export const WIDTH = 275;     // a Winamp window, in skin pixels
export const WINDOW_H = 116;  // main and equalizer are each this tall
export const ROW_H = 29;      // the playlist grows in steps of this
const MAX_SCALE = 3;

// w, h: the viewport. inset: the safe-area insets {top, right, left}, which on
// an iPhone Duo can differ left and right. bar: the strip kept clear at the
// bottom. All in CSS px; everything returned except scale is in skin px.
export function fit(w, h, inset = {}, bar = 0) {
  const { top = 0, right = 0, left = 0 } = inset;
  const roomW = Math.max(1, w - left - right);
  const roomH = Math.max(1, h - top - bar);
  const [one, two] = [1, 2].map(cols => ({
    cols,
    scale: Math.min(roomW / (WIDTH * cols), roomH / (WINDOW_H * (cols === 1 ? 3 : 2)), MAX_SCALE),
  }));
  // One column unless two make the skin noticeably bigger.
  const { cols, scale } = two.scale > one.scale * 1.1 ? two : one;

  const playlistTop = cols === 1 ? WINDOW_H * 2 : 0;
  const playlistH = Math.max(WINDOW_H, roomH / scale - playlistTop); // down to the bar
  const x = (left + (roomW - WIDTH * cols * scale) / 2) / scale;    // centred in the room
  const y = top / scale;
  return {
    scale,
    cols,
    positions: {
      main: { x, y },
      equalizer: { x, y: y + WINDOW_H },
      playlist: { x: cols === 1 ? x : x + WIDTH, y: y + playlistTop },
    },
    // Whole rows for Webamp; app.js pins the exact height with CSS.
    rows: Math.max(0, Math.floor((playlistH - WINDOW_H) / ROW_H)),
    playlistH,
    // The box Webamp keeps its windows inside: the whole screen. Webamp shoves
    // any window that leaves it, which is what scattered them on a fold.
    stage: { width: w / scale, height: (h - bar) / scale },
  };
}
