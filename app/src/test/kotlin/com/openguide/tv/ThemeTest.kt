package com.openguide.tv

import com.openguide.tv.data.*
import org.junit.Assert.*
import org.junit.Test
import java.util.Random

/** The same guarantees as server/test/theme.test.js: whatever two colors a bar picks, text stays readable. */
class ThemeTest {
    private fun check(t: ThemeColors, label: String) {
        for (b in listOf(t.bg, t.header, t.cellEmpty, t.panel, t.cell, t.cellNow)) {
            assertTrue("$label: text", contrast(t.text, b) >= 7)
            assertTrue("$label: highlight", contrast(t.accent, b) >= 4.5)
            assertTrue("$label: muted", contrast(t.muted, b) >= 4.5)
        }
        assertTrue("$label: text on highlight", contrast(t.onAccent, t.accent) >= 4.5)
    }

    @Test fun presetsAreReadable() {
        listOf("#1b5e20" to "#ffc107", "#0d2b5c" to "#f2b632", "#6d1a2e" to "#f4c27a", "#263238" to "#4dd0c8",
            "#1a1037" to "#ff5fa2", "#2b2b2b" to "#ff8a3d").forEach { (a, b) -> check(deriveTheme(BarTheme(a, b)), "$a $b") }
    }

    @Test fun awkwardPicksAreReadable() {
        listOf("#ffffff" to "#ffffff", "#000000" to "#000000", "#0000ff" to "#0000ff", "#ffff00" to "#ffffff",
            "#ff0000" to "#800000", "#7f7f7f" to "#7f7f7f", "#00ff00" to "#003300").forEach { (a, b) -> check(deriveTheme(BarTheme(a, b)), "$a $b") }
    }

    @Test fun randomPicksAreReadable() {
        val r = Random(42)
        repeat(500) {
            val a = "#%06x".format(r.nextInt(0x1000000))
            val b = "#%06x".format(r.nextInt(0x1000000))
            check(deriveTheme(BarTheme(a, b)), "$a $b")
        }
    }

    @Test fun matchesTheAdminSitePreview() {
        // Values from server/public/shared/theme.js for Pub green, so the preview shows what the TV draws.
        val t = deriveTheme(BarTheme("#1b5e20", "#ffc107"))
        assertEquals(0xFF081C09.toInt(), t.bg)
        assertEquals(0xFFFFC107.toInt(), t.accent)
    }

    @Test fun parsesThemeAndLayout() {
        val json = """{"version":1,"venue":{"name":"X","logo":null,"timezone":"UTC","theme":{"primary":"#1b5e20","secondary":"#ffc107"}},
            "screen":{"id":"s","name":"A","layout":"framed"},"menus":[],"events":[],"specials":[]}"""
        val f = parseBarFeed(json)
        assertEquals(BarTheme("#1b5e20", "#ffc107"), f.venue.theme)
        assertTrue(f.framed)
        val plain = parseBarFeed(json.replace(""""theme":{"primary":"#1b5e20","secondary":"#ffc107"}""", """"theme":null""").replace("framed", "full"))
        assertNull(plain.venue.theme)
        assertFalse(plain.framed)
    }
}
