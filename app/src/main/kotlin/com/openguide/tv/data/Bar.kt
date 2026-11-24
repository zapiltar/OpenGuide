package com.openguide.tv.data

import org.json.JSONArray
import org.json.JSONObject

// Bar Mode: a TV linked to a bar shows that bar's menus, events and specials, managed on the bar's website
// (the server in this repo's server/ folder). This file holds what the TV gets and the rules for when a special
// appears, kept free of Android so they can be unit tested.

/** [theme] is null when the bar keeps OpenGuide's own colors. */
data class BarVenue(val name: String, val logo: String?, val timezone: String, val theme: BarTheme? = null)
data class MenuItem(val name: String, val price: String?, val description: String?)
data class MenuSection(val title: String?, val items: List<MenuItem>)
/** A menu is either a picture ([image]) or typed-in [sections]. */
data class BarMenu(val id: String, val title: String, val image: String?, val sections: List<MenuSection>)
data class BarEvent(
    val id: String,
    val title: String,
    val description: String?,
    val image: String?,
    val start: Long,
    val end: Long?,
    /** On the Bar Channel, show only [image], filling the screen. */
    val fullScreen: Boolean = false,
)
data class Occurrence(val start: Long, val end: Long)

data class Special(
    val id: String,
    val title: String,
    val text: String?,
    val image: String?,
    /** Covers the whole screen, rather than a banner along the top. */
    val takeover: Boolean,
    /** Seconds on screen each time it appears, or null to keep a banner up until the special ends. */
    val timeoutSeconds: Int?,
    /** Minutes between appearances while it's on, or null to appear once per occurrence. */
    val repeatMinutes: Int?,
    /** Start and end times worked out by the server, in the bar's time zone, for about the next week. */
    val occurrences: List<Occurrence>,
    /** A takeover that is only [image], filling the screen, with no text over it. */
    val pictureOnly: Boolean = false,
)

/** What the Bar Channel shows, set on the website's Bar Channel tab. */
data class BarChannelSettings(
    val enabled: Boolean = true,
    val onNow: Boolean = true,
    val later: Boolean = true,
    val events: Boolean = true,
    val posters: Boolean = true,
    val hiddenMenus: Set<String> = emptySet(),
    val seconds: Int = 12,
)

data class BarFeed(
    val version: Int,
    val venue: BarVenue,
    val screenName: String,
    /** The picture fills the screen, or is framed by the bar's info along the left and bottom. */
    val framed: Boolean = false,
    val menus: List<BarMenu>,
    val events: List<BarEvent>,
    val specials: List<Special>,
    val channel: BarChannelSettings = BarChannelSettings(),
)

const val BAR_CHANNEL_ID = "openguide.bar-channel"

/** The linked bar's own channel: its menus, events and specials, one after another. Named after the bar. */
fun barChannel(feed: BarFeed) = Channel(BAR_CHANNEL_ID, feed.venue.name, "", emptyList(), feed.venue.logo, emptyList(), emptyList())

/** Channels the app draws itself, with no stream to play. */
fun isVirtualChannel(id: String?) = id == GUIDE_CHANNEL_ID || id == BAR_CHANNEL_ID

private fun JSONObject.str(name: String): String? = if (isNull(name)) null else optString(name).takeIf { it.isNotEmpty() }
private fun JSONObject.int(name: String): Int? = if (isNull(name) || !has(name)) null else getInt(name)
private fun JSONObject.long(name: String): Long? = if (isNull(name) || !has(name)) null else getLong(name)
private inline fun <T> JSONArray?.map(f: (JSONObject) -> T): List<T> =
    if (this == null) emptyList() else (0 until length()).map { f(getJSONObject(it)) }

/** Reads the server's GET /api/tv/feed response. Throws [org.json.JSONException] if it isn't one. */
fun parseBarFeed(json: String): BarFeed {
    val o = JSONObject(json)
    val venue = o.getJSONObject("venue")
    return BarFeed(
        version = o.getInt("version"),
        venue = BarVenue(
            venue.getString("name"),
            venue.str("logo"),
            venue.getString("timezone"),
            venue.optJSONObject("theme")?.let { t ->
                BarTheme(t.getString("primary"), t.getString("secondary")).takeIf { isHexColor(it.primary) && isHexColor(it.secondary) }
            },
        ),
        channel = venue.optJSONObject("channel")?.let { c ->
            BarChannelSettings(
                enabled = c.optBoolean("enabled", true),
                onNow = c.optBoolean("onNow", true),
                later = c.optBoolean("later", true),
                events = c.optBoolean("events", true),
                posters = c.optBoolean("posters", true),
                hiddenMenus = c.optJSONArray("hiddenMenus")?.let { a -> (0 until a.length()).map { a.getString(it) }.toSet() } ?: emptySet(),
                seconds = c.optInt("seconds", 12).coerceIn(5, 60),
            )
        } ?: BarChannelSettings(),
        screenName = o.getJSONObject("screen").getString("name"),
        framed = o.getJSONObject("screen").optString("layout") == "framed",
        menus = o.optJSONArray("menus").map { m ->
            BarMenu(
                id = m.getString("id"),
                title = m.getString("title"),
                image = m.str("image").takeIf { m.optString("kind") == "image" },
                sections = (if (m.isNull("sections")) null else m.optJSONArray("sections")).map { s ->
                    MenuSection(s.str("title"), s.optJSONArray("items").map { MenuItem(it.getString("name"), it.str("price"), it.str("description")) })
                },
            )
        },
        events = o.optJSONArray("events").map { e ->
            BarEvent(
                e.getString("id"), e.getString("title"), e.str("description"), e.str("image"), e.getLong("start"), e.long("end"),
                fullScreen = e.optBoolean("fullScreen") && e.str("image") != null,
            )
        },
        specials = o.optJSONArray("specials").map { s ->
            Special(
                id = s.getString("id"),
                title = s.getString("title"),
                text = s.str("text"),
                image = s.str("image"),
                takeover = s.optString("display") in setOf("takeover", "picture"),
                timeoutSeconds = s.int("timeoutSeconds"),
                pictureOnly = s.optString("display") == "picture" && s.str("image") != null,
                repeatMinutes = s.int("repeatMinutes"),
                occurrences = s.optJSONArray("occurrences").map { Occurrence(it.getLong("start"), it.getLong("end")) },
            )
        },
    )
}

/** One time a special is put on screen. [key] identifies it, so it isn't shown again once dismissed or timed out. */
data class Appearance(val key: String, val special: Special, val until: Long)

/**
 * The special that should go on screen at [now], or null. A special that's on appears at its start and then
 * every [Special.repeatMinutes]. Each appearance ([Appearance.key]) shows once: [shown] lists those already
 * shown. A TV switched on partway through a special shows its latest appearance straight away. When several
 * are due, the one due longest goes first, so they take turns.
 */
fun dueAppearance(specials: List<Special>, now: Long, shown: Set<String>): Appearance? {
    var best: Appearance? = null
    var bestDue = Long.MAX_VALUE
    for (s in specials) {
        for (o in s.occurrences) {
            if (now < o.start || now >= o.end) continue
            val every = s.repeatMinutes?.let { it * 60_000L }
            val slot = if (every == null) 0L else (now - o.start) / every
            val key = "${s.id}@${o.start}#$slot"
            if (key in shown) continue
            val due = o.start + slot * (every ?: 0L)
            if (due < bestDue) {
                val until = s.timeoutSeconds?.let { minOf(o.end, now + it * 1000L) } ?: o.end
                best = Appearance(key, s, until)
                bestDue = due
            }
        }
    }
    return best
}

/** Upcoming events for the Bar Channel: those still on or yet to start, soonest first. */
fun upcomingEvents(events: List<BarEvent>, now: Long, limit: Int = 6): List<BarEvent> =
    events.filter { (it.end ?: it.start) >= now }.sortedBy { it.start }.take(limit)

/** Specials with an occurrence that hasn't ended in the next [within] milliseconds, and when that occurrence is. */
fun specialsComingUp(specials: List<Special>, now: Long, within: Long): List<Pair<Special, Occurrence>> =
    specials.mapNotNull { s -> s.occurrences.firstOrNull { it.end > now && it.start < now + within }?.let { s to it } }
        .sortedBy { it.second.start }
