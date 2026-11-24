// Turns a bar's two chosen colors into every color the TV app uses, so staff can't pick an unreadable combination.
// The app has a copy of these rules in Kotlin (data/Theme.kt); the admin site uses this one for its preview.
// Keep the two in step: both have tests that check the same contrast guarantees.
//
// - The main color only sets the hue and tint of the backgrounds, which are always very dark, like the default.
// - The highlight color is lightened until it stands out from those backgrounds (WCAG contrast 4.5:1 or more).
// - Body text stays near-white; secondary text is tinted, and also kept at 4.5:1.

export const PRESETS = [
  { name: "Pub green", primary: "#1b5e20", secondary: "#ffc107" },
  { name: "Navy & gold", primary: "#0d2b5c", secondary: "#f2b632" },
  { name: "Burgundy", primary: "#6d1a2e", secondary: "#f4c27a" },
  { name: "Slate & teal", primary: "#263238", secondary: "#4dd0c8" },
  { name: "Midnight & pink", primary: "#1a1037", secondary: "#ff5fa2" },
  { name: "Charcoal & orange", primary: "#2b2b2b", secondary: "#ff8a3d" },
];

export const isHexColor = (v) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]) {
  return "#" + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");
}

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255];
}

const hsl = (h, s, l) => rgbToHex(hslToRgb(h, s, l));

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** The lightest of [backgrounds], which every foreground color has to stand out from. */
function lightestOf(colors) {
  return colors.reduce((best, c) => (luminance(c) > luminance(best) ? c : best));
}

/** Raises the lightness of (h, s, l) until it reaches [ratio] against [against]. */
function readable(h, s, l, against, ratio) {
  let light = l;
  let c = hsl(h, s, light);
  while (contrast(c, against) < ratio && light < 0.97) {
    light = Math.min(0.97, light + 0.02);
    c = hsl(h, s, light);
  }
  return c;
}

const TEXT = "#f4f6ff";

/** (h, s, l), darkened until body text reaches 7:1 on it. Yellows and greens need it most. */
function background(h, s, l) {
  let light = l;
  let c = hsl(h, s, light);
  while (contrast(TEXT, c) < 7 && light > 0.02) {
    light -= 0.01;
    c = hsl(h, s, light);
  }
  return c;
}

export function deriveTheme(primary, secondary) {
  const [h, s0] = rgbToHsl(hexToRgb(primary));
  const s = Math.min(s0, 0.6);
  const bg = {
    bg: background(h, s, 0.07),
    header: background(h, s, 0.09),
    cellEmpty: background(h, s, 0.11),
    panel: background(h, s, 0.13),
    cell: background(h, s, 0.17),
    cellNow: background(h, s, 0.24),
  };
  const lightest = lightestOf(Object.values(bg));
  const [h2, s2, l2] = rgbToHsl(hexToRgb(secondary));
  const accent = readable(h2, s2, Math.max(l2, 0.5), lightest, 4.5);
  return {
    ...bg,
    accent,
    onAccent: hsl(h2, Math.min(s2, 0.5), 0.07),
    text: TEXT,
    muted: readable(h, Math.min(s, 0.3), 0.7, lightest, 4.5),
    faint: readable(h, Math.min(s, 0.25), 0.5, bg.bg, 3),
  };
}
