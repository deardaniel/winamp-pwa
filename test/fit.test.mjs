// The layout must keep all three windows on screen at every size an iPhone
// Duo goes through, folded or open, upright or on its side.
import { fit, WIDTH, WINDOW_H } from "../fit.js";

let ok = true;
const check = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) ok = false; };

const sizes = {
  "iPhone 15 Pro": [393, 852, { top: 59, bottom: 34 }],
  "Duo folded": [382, 580, {}],
  "Duo open": [669, 825, {}],
  "Duo open, on its side": [951, 543, {}],
  "Duo folded, on its side": [678, 340, { right: 44 }],
  "iPad": [820, 1180, { top: 24, bottom: 20 }],
};

for (const [name, [w, h, inset]] of Object.entries(sizes)) {
  const bar = inset.bottom || 0;
  const f = fit(w, h, inset, bar);
  const boxes = ["main", "equalizer", "playlist"].map(k => {
    const p = f.positions[k];
    const height = k === "playlist" ? f.playlistH : WINDOW_H;
    return { left: p.x, top: p.y, right: p.x + WIDTH, bottom: p.y + height };
  });
  const s = f.scale;
  check(boxes.every(b => b.left * s >= (inset.left || 0) - 0.5 && b.right * s <= w - (inset.right || 0) + 0.5 &&
                         b.top * s >= (inset.top || 0) - 0.5 && b.bottom * s <= h - bar + 0.5),
    `${name} ${w}x${h}: ${f.cols} column(s) at ${s.toFixed(2)}x, all inside the safe area`);
  check(boxes.every(b => b.right <= f.stage.width + 0.01 && b.bottom <= f.stage.height + 0.01),
    `${name}: inside Webamp's box, so it leaves them alone`);
  check(f.playlistH >= WINDOW_H, `${name}: playlist at least one window tall`);
}

check(fit(382, 580).cols === 1 && fit(669, 825).cols === 1, "upright is one column");
check(fit(951, 543).cols === 2, "open on its side is two columns");
check(Math.abs(fit(393, 852, { top: 59 }, 34).scale - 393 / WIDTH) < 1e-9,
  "an ordinary iPhone still fills the width, as before");

if (!ok) process.exit(1);
