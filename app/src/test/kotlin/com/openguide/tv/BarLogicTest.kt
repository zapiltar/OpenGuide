package com.openguide.tv

import com.openguide.tv.data.*
import org.junit.Assert.*
import org.junit.Test

class BarLogicTest {
    private val min = 60_000L
    private fun special(
        id: String = "s",
        start: Long = 1000 * min,
        end: Long = 1180 * min,
        timeout: Int? = 30,
        repeat: Int? = null,
        takeover: Boolean = false,
    ) = Special(id, id, null, null, takeover, timeout, repeat, listOf(Occurrence(start, end)))

    @Test fun nothingBeforeOrAfter() {
        val s = special()
        assertNull(dueAppearance(listOf(s), 999 * min, emptySet()))
        assertNull(dueAppearance(listOf(s), 1180 * min, emptySet()))
    }

    @Test fun showsAtStartForItsTimeout() {
        val a = dueAppearance(listOf(special(timeout = 30)), 1000 * min, emptySet())!!
        assertEquals(1000 * min + 30_000, a.until)
    }

    @Test fun showsOnceWithoutRepeat() {
        val s = special()
        val a = dueAppearance(listOf(s), 1000 * min, emptySet())!!
        assertNull(dueAppearance(listOf(s), 1001 * min, setOf(a.key)))
        assertNull(dueAppearance(listOf(s), 1170 * min, setOf(a.key)))
    }

    @Test fun repeatsEveryInterval() {
        val s = special(repeat = 20)
        val first = dueAppearance(listOf(s), 1000 * min, emptySet())!!
        assertNull(dueAppearance(listOf(s), 1019 * min, setOf(first.key)))
        val second = dueAppearance(listOf(s), 1020 * min, setOf(first.key))!!
        assertNotEquals(first.key, second.key)
    }

    @Test fun showsTheLatestAppearanceWhenSwitchedOnPartway() {
        val s = special(repeat = 20)
        val a = dueAppearance(listOf(s), 1065 * min, emptySet())!!
        assertTrue(a.key.endsWith("#3"))
        // ...and not the three it missed, one after another.
        assertNull(dueAppearance(listOf(s), 1066 * min, setOf(a.key)))
    }

    @Test fun untilTheEndMeansUntilTheSpecialEnds() {
        val a = dueAppearance(listOf(special(timeout = null)), 1010 * min, emptySet())!!
        assertEquals(1180 * min, a.until)
    }

    @Test fun neverOutlastsTheSpecial() {
        val a = dueAppearance(listOf(special(timeout = 600)), 1179 * min, emptySet())!!
        assertEquals(1180 * min, a.until)
    }

    @Test fun specialsDueTogetherTakeTurns() {
        val early = special("early", start = 1000 * min)
        val late = special("late", start = 1005 * min)
        val first = dueAppearance(listOf(late, early), 1006 * min, emptySet())!!
        assertEquals("early", first.special.id)
        val second = dueAppearance(listOf(late, early), 1007 * min, setOf(first.key))!!
        assertEquals("late", second.special.id)
    }

    @Test fun eachOccurrenceIsSeparate() {
        val s = Special("s", "s", null, null, false, 30, null, listOf(Occurrence(1000 * min, 1060 * min), Occurrence(2000 * min, 2060 * min)))
        val monday = dueAppearance(listOf(s), 1000 * min, emptySet())!!
        assertNotNull(dueAppearance(listOf(s), 2000 * min, setOf(monday.key)))
    }

    @Test fun upcomingEventsSkipFinishedOnes() {
        val events = listOf(
            BarEvent("past", "Past", null, null, 0, 10),
            BarEvent("later", "Later", null, null, 300, null),
            BarEvent("now", "Now", null, null, 50, 200),
        )
        assertEquals(listOf("now", "later"), upcomingEvents(events, 100).map { it.id })
    }

    @Test fun parsesTheServerFeed() {
        val json = """
            {"version":3,"serverTime":1,"venue":{"name":"Corner Tap","logo":"http://x/img/a.png","timezone":"America/New_York"},
             "screen":{"id":"sc","name":"Bar left"},
             "menus":[{"id":"m1","title":"Drinks","kind":"list","image":null,
                       "sections":[{"title":"Beer","items":[{"name":"Lager","price":"${'$'}5","description":null}]}]},
                      {"id":"m2","title":"Food","kind":"image","image":"http://x/img/b.png","sections":null}],
             "events":[{"id":"e","title":"Trivia","description":null,"image":null,"start":10,"end":null}],
             "specials":[{"id":"s","title":"Happy Hour","text":"${'$'}3 drafts","image":null,"display":"takeover",
                          "timeoutSeconds":null,"repeatMinutes":20,"occurrences":[{"start":5,"end":9}]}]}
        """.trimIndent()
        val f = parseBarFeed(json)
        assertEquals("Corner Tap", f.venue.name)
        assertEquals("Bar left", f.screenName)
        assertEquals("Lager", f.menus[0].sections[0].items[0].name)
        assertEquals("\$5", f.menus[0].sections[0].items[0].price)
        assertNull(f.menus[0].image)
        assertEquals("http://x/img/b.png", f.menus[1].image)
        assertTrue(f.menus[1].sections.isEmpty())
        assertNull(f.events[0].end)
        val s = f.specials[0]
        assertTrue(s.takeover)
        assertNull(s.timeoutSeconds)
        assertEquals(20, s.repeatMinutes)
        assertEquals(listOf(Occurrence(5, 9)), s.occurrences)
    }

    @Test fun parsesPictureSpecials() {
        val base = """{"version":1,"venue":{"name":"X","logo":null,"timezone":"UTC"},"screen":{"id":"s","name":"A"},"menus":[],"events":[],
            "specials":[{"id":"p","title":"Poster","text":null,"image":IMG,"display":"picture","timeoutSeconds":15,"repeatMinutes":null,"occurrences":[]}]}"""
        val s = parseBarFeed(base.replace("IMG", "\"http://x/p.png\"")).specials[0]
        assertTrue(s.takeover)
        assertTrue(s.pictureOnly)
        // Without its picture it falls back to an ordinary takeover, rather than an empty screen.
        val noImage = parseBarFeed(base.replace("IMG", "null")).specials[0]
        assertTrue(noImage.takeover)
        assertFalse(noImage.pictureOnly)
    }

    @Test fun parsesFullScreenEvents() {
        val json = """{"version":1,"venue":{"name":"X","logo":null,"timezone":"UTC"},"screen":{"id":"s","name":"A"},"menus":[],"specials":[],
            "events":[{"id":"a","title":"Gig","description":null,"image":"http://x/a.png","fullScreen":true,"start":1,"end":null},
                      {"id":"b","title":"No picture","description":null,"image":null,"fullScreen":true,"start":2,"end":null},
                      {"id":"c","title":"Older server","description":null,"image":"http://x/c.png","start":3,"end":null}]}"""
        assertEquals(listOf(true, false, false), parseBarFeed(json).events.map { it.fullScreen })
    }

    @Test fun parsesBarChannelSettings() {
        val base = """{"version":1,"venue":{"name":"X","logo":null,"timezone":"UTC"CHANNEL},"screen":{"id":"s","name":"A"},"menus":[],"events":[],"specials":[]}"""
        assertEquals(BarChannelSettings(), parseBarFeed(base.replace("CHANNEL", "")).channel)
        val c = parseBarFeed(base.replace("CHANNEL", ""","channel":{"enabled":false,"onNow":true,"later":false,"events":true,"posters":false,"hiddenMenus":["m1"],"seconds":20}""")).channel
        assertEquals(BarChannelSettings(enabled = false, later = false, posters = false, hiddenMenus = setOf("m1"), seconds = 20), c)
    }

    @Test fun barChannelIsVirtual() {
        assertTrue(isVirtualChannel(BAR_CHANNEL_ID))
        assertTrue(isVirtualChannel(GUIDE_CHANNEL_ID))
        assertFalse(isVirtualChannel("cnn.us"))
    }
}
