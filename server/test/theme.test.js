import { describe, expect, it } from "vitest";
import { PRESETS, contrast, deriveTheme } from "../public/shared/theme.js";

const BACKGROUNDS = ["bg", "header", "cellEmpty", "panel", "cell", "cellNow"];

function randomColor(seed) {
  // A small deterministic generator, so a failure can be reproduced.
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return "#" + Math.floor((x - Math.floor(x)) * 0xffffff).toString(16).padStart(6, "0");
}

function checkReadable(t, label) {
  for (const b of BACKGROUNDS) {
    expect(contrast(t.text, t[b]), `${label}: text on ${b}`).toBeGreaterThanOrEqual(7);
    expect(contrast(t.accent, t[b]), `${label}: highlight on ${b}`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.muted, t[b]), `${label}: muted on ${b}`).toBeGreaterThanOrEqual(4.5);
  }
  expect(contrast(t.onAccent, t.accent), `${label}: text on highlight`).toBeGreaterThanOrEqual(4.5);
}

describe("deriveTheme", () => {
  it("keeps every preset readable", () => {
    for (const p of PRESETS) checkReadable(deriveTheme(p.primary, p.secondary), p.name);
  });

  it("keeps awkward picks readable", () => {
    const awkward = [
      ["#ffffff", "#ffffff"], ["#000000", "#000000"], ["#0000ff", "#0000ff"], ["#ffff00", "#ffffff"],
      ["#ff0000", "#800000"], ["#7f7f7f", "#7f7f7f"], ["#00ff00", "#003300"],
    ];
    for (const [a, b] of awkward) checkReadable(deriveTheme(a, b), `${a} + ${b}`);
  });

  it("keeps 500 random picks readable", () => {
    for (let i = 0; i < 500; i++) {
      const a = randomColor(i);
      const b = randomColor(i + 1000);
      checkReadable(deriveTheme(a, b), `${a} + ${b}`);
    }
  });

  it("always uses dark backgrounds, even for a white main color", () => {
    const t = deriveTheme("#ffffff", "#ffc107");
    expect(contrast(t.bg, "#000000")).toBeLessThan(1.3);
  });
});
