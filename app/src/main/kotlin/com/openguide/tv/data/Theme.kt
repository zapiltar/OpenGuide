package com.openguide.tv.data

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

// A bar's two chosen colors, turned into every color the app draws with. This is a copy of the admin site's
// rules in server/public/shared/theme.js, which shows bars a preview: keep the two in step. Both have tests
// for the same guarantees, so whatever a bar picks, text stays readable:
// - Backgrounds take the main color's hue and tint, but are always very dark, and dark enough for 7:1 text.
// - The highlight color is lightened until it reaches 4.5:1 against every background.

data class BarTheme(val primary: String, val secondary: String)

/** Colors as 0xAARRGGBB, named as in ui.Palette. */
data class ThemeColors(
    val bg: Int, val header: Int, val cellEmpty: Int, val panel: Int, val cell: Int, val cellNow: Int,
    val accent: Int, val onAccent: Int, val text: Int, val muted: Int, val faint: Int,
)

fun isHexColor(v: String?) = v != null && Regex("^#[0-9a-fA-F]{6}$").matches(v)

private fun hexToRgb(hex: String): IntArray {
    val n = hex.substring(1).toInt(16)
    return intArrayOf((n shr 16) and 255, (n shr 8) and 255, n and 255)
}

private fun rgbToInt(r: Double, g: Double, b: Double): Int =
    (0xFF shl 24) or (r.roundToInt().coerceIn(0, 255) shl 16) or (g.roundToInt().coerceIn(0, 255) shl 8) or b.roundToInt().coerceIn(0, 255)

private fun rgbToHsl(rgb: IntArray): DoubleArray {
    val r = rgb[0] / 255.0
    val g = rgb[1] / 255.0
    val b = rgb[2] / 255.0
    val mx = max(r, max(g, b))
    val mn = min(r, min(g, b))
    val l = (mx + mn) / 2
    if (mx == mn) return doubleArrayOf(0.0, 0.0, l)
    val d = mx - mn
    val s = if (l > 0.5) d / (2 - mx - mn) else d / (mx + mn)
    val h = when (mx) {
        r -> (g - b) / d + (if (g < b) 6 else 0)
        g -> (b - r) / d + 2
        else -> (r - g) / d + 4
    }
    return doubleArrayOf(h * 60, s, l)
}

private fun hsl(h: Double, s: Double, l: Double): Int {
    val c = (1 - abs(2 * l - 1)) * s
    val hp = (((h % 360) + 360) % 360) / 60
    val x = c * (1 - abs(hp % 2 - 1))
    val (r1, g1, b1) = when {
        hp < 1 -> Triple(c, x, 0.0)
        hp < 2 -> Triple(x, c, 0.0)
        hp < 3 -> Triple(0.0, c, x)
        hp < 4 -> Triple(0.0, x, c)
        hp < 5 -> Triple(x, 0.0, c)
        else -> Triple(c, 0.0, x)
    }
    val m = l - c / 2
    return rgbToInt((r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255)
}

private fun luminance(color: Int): Double {
    fun ch(v: Int): Double {
        val c = v / 255.0
        return if (c <= 0.03928) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
    }
    return 0.2126 * ch((color shr 16) and 255) + 0.7152 * ch((color shr 8) and 255) + 0.0722 * ch(color and 255)
}

fun contrast(a: Int, b: Int): Double {
    val x = luminance(a)
    val y = luminance(b)
    return (max(x, y) + 0.05) / (min(x, y) + 0.05)
}

private const val TEXT = 0xFFF4F6FF.toInt()

private fun background(h: Double, s: Double, l: Double): Int {
    var light = l
    var c = hsl(h, s, light)
    while (contrast(TEXT, c) < 7 && light > 0.02) {
        light -= 0.01
        c = hsl(h, s, light)
    }
    return c
}

private fun readable(h: Double, s: Double, l: Double, against: Int, ratio: Double): Int {
    var light = l
    var c = hsl(h, s, light)
    while (contrast(c, against) < ratio && light < 0.97) {
        light = min(0.97, light + 0.02)
        c = hsl(h, s, light)
    }
    return c
}

fun deriveTheme(t: BarTheme): ThemeColors {
    val p = rgbToHsl(hexToRgb(t.primary))
    val h = p[0]
    val s = min(p[1], 0.6)
    val bg = background(h, s, 0.07)
    val header = background(h, s, 0.09)
    val cellEmpty = background(h, s, 0.11)
    val panel = background(h, s, 0.13)
    val cell = background(h, s, 0.17)
    val cellNow = background(h, s, 0.24)
    val lightest = listOf(bg, header, cellEmpty, panel, cell, cellNow).maxBy(::luminance)
    val q = rgbToHsl(hexToRgb(t.secondary))
    return ThemeColors(
        bg = bg, header = header, cellEmpty = cellEmpty, panel = panel, cell = cell, cellNow = cellNow,
        accent = readable(q[0], q[1], max(q[2], 0.5), lightest, 4.5),
        onAccent = hsl(q[0], min(q[1], 0.5), 0.07),
        text = TEXT,
        muted = readable(h, min(s, 0.3), 0.7, lightest, 4.5),
        faint = readable(h, min(s, 0.25), 0.5, bg, 3.0),
    )
}
