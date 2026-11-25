package com.openguide.tv.data

import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

// Bar Mode: a TV linked to a bar shows that bar's menus, events and specials, managed on the bar's website
// (the server in this repo's server/ folder). This file holds what the TV gets and the rules for when a special
// appears, kept free of Android so they can be unit tested.

/** [theme] is null when the bar keeps OpenGuide's own colors. */
data class BarVenue(val name: String, val logo: String?, val timezone: String, val theme: BarTheme? = null)
/** [image] is the address of the item's optional picture. */
data class MenuItem(val name: String, val price: String?, val description: String?, val image: String? = null)
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

/** What a bar's TVs show during Pluto TV ad breaks. */
enum class AdBreakShow(val id: String) {
    EVENTS("events"), CHANNEL("channel"), MENU("menu"), PICTURE("picture"), OFF("off");

    companion object {
        fun of(id: String?) = entries.firstOrNull { it.id == id } ?: EVENTS
    }
}

/** Set on the website's Bar Channel tab. [image] is the picture's address. */
data class AdBreaks(
    val show: AdBreakShow = AdBreakShow.EVENTS,
    val menuId: String? = null,
    val image: String? = null,
    val mute: Boolean = true,
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
    /** Whether the picture fills the screen or is framed by the bar's info along the left and bottom. */
    val layout: BarLayout = BarLayout.FULL,
    val menus: List<BarMenu>,
    val events: List<BarEvent>,
    val specials: List<Special>,
    val channel: BarChannelSettings = BarChannelSettings(),
    /** Whether the bar has bingo on, so the Bingo channel is in the guide. */
    val bingo: Boolean = false,
    val adBreaks: AdBreaks = AdBreaks(),
    /** Where this TV's weather is for, or null if the server couldn't tell. */
    val weatherPlace: WeatherPlace? = null,
)

/** How a linked TV shows channels. [id] is the server's name for it. */
enum class BarLayout(val id: String, val label: String) {
    FULL("full", "Full picture"),
    FRAMED("framed", "Framed"),
    /** Full picture, framed only while one of the bar's specials is on. */
    DURING_SPECIALS("specials", "Framed during specials");

    companion object {
        fun of(id: String?) = entries.firstOrNull { it.id == id } ?: FULL
    }
}

/**
 * Whether the picture is framed at [now]. A screen that can be framed never shows banners or takeovers, because
 * the frame's bottom bar shows the specials instead.
 */
fun framedAt(feed: BarFeed, now: Long): Boolean = when (feed.layout) {
    BarLayout.FULL -> false
    BarLayout.FRAMED -> true
    BarLayout.DURING_SPECIALS -> feed.specials.any { s -> s.occurrences.any { now >= it.start && now < it.end } }
}

/** The weather where the bar is, for framed screens. [kind] is clear, partly, cloudy, fog, rain, sleet, snow or storm. */
data class Weather(val temp: Int, val unit: String, val kind: String, val day: Boolean)

/** An icon for the sky, as an emoji so it needs no pictures of its own. */
fun weatherIcon(w: Weather): String = when (w.kind) {
    "clear" -> if (w.day) "\u2600\uFE0F" else "\uD83C\uDF19"
    "partly" -> if (w.day) "\u26C5" else "\u2601\uFE0F"
    "fog" -> "\uD83C\uDF2B\uFE0F"
    "rain" -> "\uD83C\uDF27\uFE0F"
    "sleet" -> "\uD83C\uDF28\uFE0F"
    "snow" -> "\u2744\uFE0F"
    "storm" -> "\u26C8\uFE0F"
    else -> "\u2601\uFE0F"
}

/** Where a TV's weather is for. [us] means Fahrenheit. */
data class WeatherPlace(val lat: Double, val lon: Double, val us: Boolean)

/** MET Norway's forecast for [p], to two decimal places, which is about a kilometre and what it asks for. */
fun metForecastUrl(p: WeatherPlace): String =
    String.format(Locale.US, "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=%.2f&lon=%.2f", p.lat, p.lon)

/**
 * MET Norway's symbol code ("partlycloudy_night", "heavyrainandthunder") as one of the kinds there are icons
 * for, and whether it's day.
 */
fun skyOf(symbol: String?): Pair<String, Boolean> {
    val s = symbol.orEmpty()
    val day = !s.endsWith("_night")
    val base = s.replace(Regex("_(day|night|polartwilight)$"), "")
    val kind = when {
        "thunder" in base -> "storm"
        "snow" in base -> "snow"
        "sleet" in base -> "sleet"
        "rain" in base -> "rain"
        base == "fog" -> "fog"
        base == "clearsky" -> "clear"
        base == "fair" || base == "partlycloudy" -> "partly"
        else -> "cloudy"
    }
    return kind to day
}

/** The weather now from MET Norway's "compact" forecast: the latest hour that has started, or the first. */
fun parseMetForecast(json: String, now: Long, us: Boolean): Weather? {
    val series = JSONObject(json).optJSONObject("properties")?.optJSONArray("timeseries") ?: return null
    if (series.length() == 0) return null
    val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
    var entry = series.getJSONObject(0)
    for (i in 0 until series.length()) {
        val t = series.getJSONObject(i)
        val at = runCatching { iso.parse(t.getString("time"))!!.time }.getOrNull() ?: continue
        if (at <= now) entry = t else break
    }
    val data = entry.optJSONObject("data") ?: return null
    val details = data.optJSONObject("instant")?.optJSONObject("details") ?: return null
    if (!details.has("air_temperature")) return null
    val celsius = details.getDouble("air_temperature")
    val symbol = (data.optJSONObject("next_1_hours") ?: data.optJSONObject("next_6_hours"))
        ?.optJSONObject("summary")?.optString("symbol_code")
    val (kind, day) = skyOf(symbol)
    val temp = if (us) celsius * 9 / 5 + 32 else celsius
    return Weather(Math.round(temp).toInt(), if (us) "F" else "C", kind, day)
}

/** "72°", the way it sits beside the clock. */
fun weatherText(w: Weather): String = "${weatherIcon(w)} ${w.temp}\u00B0"

const val BAR_CHANNEL_ID = "openguide.bar-channel"

/** The linked bar's own channel: its menus, events and specials, one after another. Named after the bar. */
fun barChannel(feed: BarFeed) = Channel(BAR_CHANNEL_ID, feed.venue.name, "", emptyList(), feed.venue.logo, emptyList(), emptyList())

/** Channels the app draws itself, with no stream to play. */
fun isVirtualChannel(id: String?) = id == GUIDE_CHANNEL_ID || id == BAR_CHANNEL_ID || id == BINGO_CHANNEL_ID

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
        bingo = venue.optBoolean("bingo", false),
        adBreaks = venue.optJSONObject("adBreaks")?.let { a ->
            AdBreaks(AdBreakShow.of(a.str("show")), a.str("menuId"), a.str("image"), a.optBoolean("mute", true))
        } ?: AdBreaks(),
        weatherPlace = o.optJSONObject("weather")?.let { w ->
            WeatherPlace(w.getDouble("lat"), w.getDouble("lon"), w.optBoolean("us", true))
        },
        screenName = o.getJSONObject("screen").getString("name"),
        layout = BarLayout.of(o.getJSONObject("screen").optString("layout")),
        menus = o.optJSONArray("menus").map { m ->
            BarMenu(
                id = m.getString("id"),
                title = m.getString("title"),
                image = m.str("image").takeIf { m.optString("kind") == "image" },
                sections = (if (m.isNull("sections")) null else m.optJSONArray("sections")).map { s ->
                    MenuSection(s.str("title"), s.optJSONArray("items").map { MenuItem(it.getString("name"), it.str("price"), it.str("description"), it.str("image")) })
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
