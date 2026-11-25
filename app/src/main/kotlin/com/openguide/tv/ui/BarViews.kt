package com.openguide.tv.ui

import android.content.Context
import android.graphics.Color
import android.text.format.DateFormat
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import coil.ImageLoader
import coil.request.ImageRequest
import com.openguide.tv.data.Appearance
import com.openguide.tv.data.BarEvent
import com.openguide.tv.data.BarFeed
import com.openguide.tv.data.BarMenu
import com.openguide.tv.data.Occurrence
import com.openguide.tv.data.Special
import com.openguide.tv.data.Weather
import com.openguide.tv.data.weatherText
import com.openguide.tv.data.specialsComingUp
import com.openguide.tv.data.upcomingEvents
import okhttp3.OkHttpClient
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
private const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT

/** Loads the bar's pictures into views. Coil keeps them on disk, so a linked TV still shows them offline. */
class BarImages(private val ctx: Context, http: OkHttpClient) {
    private val loader = ImageLoader.Builder(ctx).okHttpClient(http).build()

    /** Shows [url] in [view], or hides the view when there's no picture. */
    fun load(view: ImageView, url: String?) {
        if (url == null) {
            view.setImageDrawable(null)
            view.visibility = View.GONE
            return
        }
        view.visibility = View.VISIBLE
        if (view.tag == url && view.drawable != null) return
        view.tag = url
        loader.enqueue(ImageRequest.Builder(ctx).data(url).target(view).build())
    }
}

/** Times on the bar's screens are in the bar's own time zone, which may not be the TV's. */
class BarClock(private val ctx: Context, timezone: String) {
    private val zone = TimeZone.getTimeZone(timezone)
    private fun fmt(pattern: String) = SimpleDateFormat(pattern, Locale.getDefault()).apply { timeZone = zone }
    private val time = fmt(if (DateFormat.is24HourFormat(ctx)) "H:mm" else "h:mm a")
    private val day = fmt("EEE MMM d")
    private val dayKey = fmt("yyyyMMdd")

    fun time(t: Long): String = time.format(Date(t))
    fun day(t: Long): String = day.format(Date(t))
    private fun sameDay(a: Long, b: Long) = dayKey.format(Date(a)) == dayKey.format(Date(b))

    /** "Fri Dec 5, 8:00 PM", or just the time when it's today. */
    fun whenText(t: Long, now: Long): String = if (sameDay(t, now)) time(t) else "${day(t)}, ${time(t)}"

    fun span(start: Long, end: Long?, now: Long): String = when {
        end == null -> whenText(start, now)
        start <= now -> "On now until ${time(end)}"
        sameDay(start, end) -> "${whenText(start, now)} to ${time(end)}"
        else -> "${whenText(start, now)} to ${whenText(end, now)}"
    }
}

/**
 * A special on screen: a banner along the top that leaves the picture visible, or a takeover that covers it.
 * Nothing here is focusable, so the remote keeps working underneath a banner; MainActivity decides what
 * the keys do while one is showing.
 */
class SpecialOverlay(ctx: Context, private val images: BarImages) : FrameLayout(ctx) {
    var appearance: Appearance? = null
        private set
    val isShowing get() = visibility == VISIBLE
    val isTakeover get() = isShowing && appearance?.special?.takeover == true

    private val banner = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        // A little see-through, so the game still shows behind it.
        background = roundRect((0xD9 shl 24) or (Palette.PANEL and 0xFFFFFF), ctx.dpf(8f), Palette.ACCENT, ctx.dp(2))
        setPadding(ctx.dp(20), ctx.dp(14), ctx.dp(24), ctx.dp(14))
    }
    private val bannerImage = ImageView(ctx).apply { scaleType = ImageView.ScaleType.FIT_CENTER }
    private val bannerKicker = ctx.label(size = 13f, color = Palette.ACCENT, bold = true)
    private val bannerTitle = ctx.label(size = 26f, bold = true, lines = 2)
    private val bannerText = ctx.label(size = 17f, color = Palette.TEXT, lines = 2)

    private val takeover = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        setBackgroundColor(Palette.BG)
        setPadding(ctx.dp(48), ctx.dp(32), ctx.dp(48), ctx.dp(24))
    }
    private val takeoverKicker = ctx.label(size = 20f, color = Palette.ACCENT, bold = true).apply { gravity = Gravity.CENTER }
    private val takeoverImage = ImageView(ctx).apply { scaleType = ImageView.ScaleType.FIT_CENTER }
    private val takeoverTitle = ctx.label(size = 52f, bold = true, lines = 2).apply { gravity = Gravity.CENTER }
    private val takeoverText = ctx.label(size = 26f, color = Palette.TEXT, lines = 3).apply { gravity = Gravity.CENTER }
    private val takeoverHint = ctx.label("Back: return to the channel", 14f, Palette.FAINT).apply { gravity = Gravity.CENTER }

    init {
        visibility = GONE
        isFocusable = false
        banner.addView(bannerImage, LinearLayout.LayoutParams(ctx.dp(140), ctx.dp(84)).apply { rightMargin = ctx.dp(18) })
        val col = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        col.addView(bannerKicker, LinearLayout.LayoutParams(MATCH, WRAP))
        col.addView(bannerTitle, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = ctx.dp(4) })
        col.addView(bannerText, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = ctx.dp(4) })
        banner.addView(col, LinearLayout.LayoutParams(0, WRAP, 1f))
        addView(banner, LayoutParams(MATCH, WRAP, Gravity.TOP).apply { setMargins(ctx.dp(24), ctx.dp(20), ctx.dp(24), 0) })

        takeover.addView(takeoverKicker, LinearLayout.LayoutParams(MATCH, WRAP))
        takeover.addView(takeoverImage, LinearLayout.LayoutParams(MATCH, 0, 1f).apply { topMargin = ctx.dp(16); bottomMargin = ctx.dp(16) })
        takeover.addView(takeoverTitle, LinearLayout.LayoutParams(MATCH, WRAP))
        takeover.addView(takeoverText, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = ctx.dp(10) })
        takeover.addView(takeoverHint, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = ctx.dp(20) })
        addView(takeover, LayoutParams(MATCH, MATCH))
    }

    fun show(a: Appearance, barName: String) {
        appearance = a
        val s = a.special
        if (s.takeover) {
            banner.visibility = GONE
            takeover.visibility = VISIBLE
            // A picture special is the bar's own design: only the image, on black, edge to edge.
            val picture = s.pictureOnly
            takeover.setBackgroundColor(if (picture) Color.BLACK else Palette.BG)
            val pad = if (picture) 0 else context.dp(48)
            takeover.setPadding(pad, if (picture) 0 else context.dp(32), pad, if (picture) 0 else context.dp(24))
            (takeoverImage.layoutParams as LinearLayout.LayoutParams).setMargins(0, if (picture) 0 else context.dp(16), 0, if (picture) 0 else context.dp(16))
            listOf(takeoverKicker, takeoverTitle, takeoverHint).forEach { it.visibility = if (picture) GONE else VISIBLE }
            takeoverKicker.text = barName
            takeoverTitle.text = s.title
            takeoverText.text = s.text.orEmpty()
            takeoverText.visibility = if (s.text.isNullOrEmpty() || picture) GONE else VISIBLE
            images.load(takeoverImage, s.image)
            // Without a picture, the empty space would push the words to the top.
            if (s.image == null) takeoverImage.visibility = INVISIBLE
        } else {
            takeover.visibility = GONE
            banner.visibility = VISIBLE
            bannerKicker.text = barName
            bannerTitle.text = s.title
            bannerText.text = s.text.orEmpty()
            bannerText.visibility = if (s.text.isNullOrEmpty()) GONE else VISIBLE
            images.load(bannerImage, s.image)
        }
        visibility = VISIBLE
    }

    fun hide() {
        appearance = null
        visibility = GONE
    }
}

/**
 * The Bar Channel: the linked bar's menus, upcoming events and specials, one page at a time, changing every
 * [PAGE_MS]. Drawn by the app like the Guide Channel, with no stream behind it.
 */
class BarChannelView(ctx: Context, private val images: BarImages, private val now: () -> Long) : LinearLayout(ctx) {
    private var feed: BarFeed? = null
    private var page = 0
    private var pageCount = 1

    private val logo = ImageView(ctx).apply { scaleType = ImageView.ScaleType.FIT_CENTER }
    private val barName = ctx.label(size = 26f, color = Palette.ACCENT, bold = true)
    private val clock = ctx.label(size = 22f, bold = true).apply { gravity = Gravity.END or Gravity.CENTER_VERTICAL }
    private val heading = ctx.label(size = 34f, bold = true)
    private val body = FrameLayout(ctx)
    private val dots = ctx.label(size = 16f, color = Palette.FAINT).apply { gravity = Gravity.CENTER }
    private val header = LinearLayout(ctx).apply { orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    private val pagePad = ctx.dp(if (Look.crt) 16 else 40)

    private val pageMs get() = (feed?.channel?.seconds ?: 12) * 1000L

    private val advance = object : Runnable {
        override fun run() {
            page = (page + 1) % pageCount
            draw()
            postDelayed(this, pageMs)
        }
    }

    init {
        orientation = VERTICAL
        visibility = GONE
        setBackgroundColor(Palette.BG)
        setChrome(true)
        header.addView(logo, LayoutParams(ctx.dp(64), ctx.dp(48)).apply { rightMargin = ctx.dp(14) })
        header.addView(barName, LayoutParams(0, WRAP, 1f))
        header.addView(clock, LayoutParams(WRAP, WRAP))
        addView(header, LayoutParams(MATCH, WRAP))
        addView(heading, LayoutParams(MATCH, WRAP).apply { topMargin = ctx.dp(18); bottomMargin = ctx.dp(14) })
        addView(body, LayoutParams(MATCH, 0, 1f))
        addView(dots, LayoutParams(MATCH, WRAP).apply { topMargin = ctx.dp(8) })
    }

    fun setFeed(next: BarFeed?) {
        feed = next
        draw()
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        removeCallbacks(advance)
        if (isShown) {
            page = 0
            draw()
            postDelayed(advance, pageMs)
        }
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        removeCallbacks(advance)
    }

    private sealed class Page {
        class Menu(val menu: BarMenu) : Page()
        class Events(val events: List<BarEvent>) : Page()
        class Poster(val event: BarEvent) : Page()
        class Specials(val specials: List<Pair<Special, Occurrence>>) : Page()
        class OnNow(val special: Special, val occurrence: Occurrence) : Page()
        object Empty : Page()
    }

    /** The pages, in order, as chosen on the website's Bar Channel tab. */
    private fun pages(f: BarFeed, t: Long): List<Page> = buildList {
        val c = f.channel
        // Specials that are on lead, each with a page of its own in big type. Later ones share a list.
        val (onNow, later) = specialsComingUp(f.specials, t, DAY_MS).partition { it.second.start <= t }
        if (c.onNow) onNow.forEach { (s, o) -> add(Page.OnNow(s, o)) }
        if (c.later && later.isNotEmpty()) add(Page.Specials(later))
        f.menus.filter { it.id !in c.hiddenMenus }.forEach { add(Page.Menu(it)) }
        val events = upcomingEvents(f.events, t)
        if (c.events && events.isNotEmpty()) add(Page.Events(events))
        // Each event with a picture can also get a page of its own, poster first.
        // A repeating event arrives as several dates ("id@start"), and gets one page, for its next date.
        if (c.posters) events.filter { it.image != null }.distinctBy { it.id.substringBefore("@") }.forEach { add(Page.Poster(it)) }
        if (isEmpty()) add(Page.Empty)
    }

    /** The header, heading, page dots and margins, which a full-screen picture page hides. */
    private fun setChrome(on: Boolean) {
        val v = if (on) VISIBLE else GONE
        header.visibility = v
        heading.visibility = v
        dots.visibility = v
        setBackgroundColor(if (on) Palette.BG else Color.BLACK)
        if (on) setPadding(pagePad, context.dp(24), pagePad, context.dp(16)) else setPadding(0, 0, 0, 0)
    }

    /** Redraws the current page. Called every page change, and by MainActivity's clock tick. */
    fun draw() {
        val f = feed ?: return
        if (!isShown) return
        val t = now()
        val bc = BarClock(context, f.venue.timezone)
        barName.text = f.venue.name
        images.load(logo, f.venue.logo)
        clock.text = bc.time(t)
        val all = pages(f, t)
        pageCount = all.size
        page %= pageCount
        dots.text = if (pageCount > 1) (0 until pageCount).joinToString("  ") { if (it == page) "●" else "○" } else ""
        body.removeAllViews()
        heading.setTextColor(Palette.TEXT)
        val p = all[page]
        val fullPicture = p is Page.Poster && p.event.fullScreen
        setChrome(!fullPicture)
        if (fullPicture) {
            val img = ImageView(context).apply { scaleType = ImageView.ScaleType.FIT_CENTER }
            body.addView(img, FrameLayout.LayoutParams(MATCH, MATCH))
            images.load(img, (p as Page.Poster).event.image)
            return
        }
        when (p) {
            is Page.Menu -> menuPage(p.menu)
            is Page.Events -> listPage("Coming up", p.events.map { e -> Triple(bc.span(e.start, e.end, t), e.title, e.description) })
            is Page.Specials -> listPage("Later today", p.specials.map { (s, o) -> Triple(bc.span(o.start, o.end, t), s.title, s.text) })
            is Page.Poster -> posterPage(p.event, bc.span(p.event.start, p.event.end, t))
            is Page.OnNow -> onNowPage(p.special, "Until ${bc.time(p.occurrence.end)}")
            Page.Empty -> {
                heading.text = "Welcome"
                body.addView(context.label("Menus, events and specials will appear here.", 22f, Palette.MUTED, lines = 3), FrameLayout.LayoutParams(MATCH, WRAP))
            }
        }
    }

    private fun menuPage(m: BarMenu) {
        heading.text = m.title
        if (m.image != null) {
            val img = ImageView(context).apply { scaleType = ImageView.ScaleType.FIT_CENTER }
            body.addView(img, FrameLayout.LayoutParams(MATCH, MATCH))
            images.load(img, m.image)
            return
        }
        // Spread sections over up to three columns, filling the shortest column each time.
        // An item with a picture takes about two lines.
        val weight = { sec: com.openguide.tv.data.MenuSection -> sec.items.sumOf { if (it.image != null) 2 else 1 } + 1 }
        val itemCount = m.sections.sumOf(weight)
        val columns = when {
            Look.crt -> minOf(2, m.sections.size)
            else -> minOf(3, m.sections.size)
        }.coerceAtLeast(1)
        val size = when {
            itemCount > 30 -> 14f
            itemCount > 18 -> 16f
            else -> 20f
        }
        val cols = List(columns) { LinearLayout(context).apply { orientation = VERTICAL } }
        val heights = IntArray(columns)
        for (section in m.sections) {
            val i = heights.indices.minBy { heights[it] }
            heights[i] += weight(section)
            val col = cols[i]
            section.title?.let {
                col.addView(context.label(it, size + 2f, Palette.ACCENT, bold = true), LayoutParams(MATCH, WRAP).apply { topMargin = context.dp(6); bottomMargin = context.dp(6) })
            }
            for (item in section.items) {
                val row = LinearLayout(context).apply { orientation = HORIZONTAL }
                row.addView(context.label(item.name, size, bold = true), LayoutParams(0, WRAP, 1f))
                item.price?.let { row.addView(context.label(it, size, Palette.ACCENT, bold = true), LayoutParams(WRAP, WRAP).apply { leftMargin = context.dp(12) }) }
                val desc = item.description?.let { context.label(it, size - 4f, Palette.MUTED, lines = 2) }
                if (item.image == null) {
                    col.addView(row, LayoutParams(MATCH, WRAP).apply { topMargin = context.dp(4) })
                    desc?.let { col.addView(it, LayoutParams(MATCH, WRAP)) }
                    continue
                }
                // The picture sits to the left of the name, price and description.
                val thumb = context.dp((size * 3.2f).toInt())
                val img = ImageView(context).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
                images.load(img, item.image)
                val text = LinearLayout(context).apply { orientation = VERTICAL; gravity = Gravity.CENTER_VERTICAL }
                text.addView(row, LayoutParams(MATCH, WRAP))
                desc?.let { text.addView(it, LayoutParams(MATCH, WRAP)) }
                val line = LinearLayout(context).apply { orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
                line.addView(img, LayoutParams(thumb, thumb).apply { rightMargin = context.dp(12) })
                line.addView(text, LayoutParams(0, WRAP, 1f))
                col.addView(line, LayoutParams(MATCH, WRAP).apply { topMargin = context.dp(6) })
            }
        }
        val row = LinearLayout(context).apply { orientation = HORIZONTAL }
        cols.forEachIndexed { i, c ->
            row.addView(c, LayoutParams(0, WRAP, 1f).apply { if (i > 0) leftMargin = context.dp(36) })
        }
        body.addView(row, FrameLayout.LayoutParams(MATCH, WRAP))
    }

    /** A special that's on now, as big as the screen allows, with its picture beside it if it has one. */
    private fun onNowPage(s: Special, untilText: String) {
        heading.text = "On now"
        heading.setTextColor(Palette.ACCENT)
        val row = LinearLayout(context).apply { orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        if (s.image != null) {
            val img = ImageView(context).apply { scaleType = ImageView.ScaleType.FIT_CENTER }
            row.addView(img, LayoutParams(0, MATCH, 1f).apply { rightMargin = context.dp(36) })
            images.load(img, s.image)
        }
        val col = LinearLayout(context).apply { orientation = VERTICAL; gravity = Gravity.CENTER_VERTICAL }
        col.addView(context.label(s.title, if (s.image != null) 64f else 84f, bold = true, lines = 3), LayoutParams(MATCH, WRAP))
        s.text?.let { col.addView(context.label(it, 34f, Palette.TEXT, lines = 3), LayoutParams(MATCH, WRAP).apply { topMargin = context.dp(14) }) }
        col.addView(context.label(untilText, 30f, Palette.ACCENT, bold = true), LayoutParams(MATCH, WRAP).apply { topMargin = context.dp(18) })
        row.addView(col, LayoutParams(0, MATCH, if (s.image != null) 1.1f else 1f))
        body.addView(row, FrameLayout.LayoutParams(MATCH, MATCH))
    }

    /** One event: its poster on the left, and when, what and the details on the right. */
    private fun posterPage(e: BarEvent, whenText: String) {
        heading.text = "Coming up"
        val row = LinearLayout(context).apply { orientation = HORIZONTAL }
        val img = ImageView(context).apply { scaleType = ImageView.ScaleType.FIT_CENTER }
        row.addView(img, LayoutParams(0, MATCH, 1.3f))
        val col = LinearLayout(context).apply { orientation = VERTICAL; gravity = Gravity.CENTER_VERTICAL }
        col.addView(context.label(whenText, 22f, Palette.ACCENT, bold = true, lines = 2), LayoutParams(MATCH, WRAP))
        col.addView(context.label(e.title, 40f, bold = true, lines = 3), LayoutParams(MATCH, WRAP).apply { topMargin = context.dp(8) })
        e.description?.let { col.addView(context.label(it, 20f, Palette.MUTED, lines = 6), LayoutParams(MATCH, WRAP).apply { topMargin = context.dp(12) }) }
        row.addView(col, LayoutParams(0, MATCH, 1f).apply { leftMargin = context.dp(32) })
        body.addView(row, FrameLayout.LayoutParams(MATCH, MATCH))
        images.load(img, e.image)
    }

    /** Rows of: when (accent), title, and an optional line of detail. */
    private fun listPage(title: String, rows: List<Triple<String, String, String?>>) {
        heading.text = title
        val col = LinearLayout(context).apply { orientation = VERTICAL }
        for ((whenText, name, detail) in rows) {
            col.addView(context.label(whenText, 18f, Palette.ACCENT, bold = true), LayoutParams(MATCH, WRAP).apply { topMargin = context.dp(12) })
            col.addView(context.label(name, 26f, bold = true), LayoutParams(MATCH, WRAP).apply { topMargin = context.dp(3) })
            detail?.let { col.addView(context.label(it, 18f, Palette.MUTED, lines = 2), LayoutParams(MATCH, WRAP).apply { topMargin = context.dp(2) }) }
        }
        body.addView(col, FrameLayout.LayoutParams(MATCH, WRAP))
    }

    private companion object {
        const val DAY_MS = 24 * 3_600_000L
    }
}

/** Shown while this TV is being linked to a bar: the code to type on the bar's website, and how it's going. */
class BarLinkPanel(ctx: Context) : FrameLayout(ctx) {
    val isShowing get() = visibility == VISIBLE
    private val heading = ctx.label("Link this TV to a bar", 28f, bold = true).apply { gravity = Gravity.CENTER }
    private val code = ctx.label("", 64f, Palette.ACCENT, bold = true).apply {
        gravity = Gravity.CENTER
        letterSpacing = 0.12f
    }
    private val message = ctx.label("", 18f, Palette.TEXT, lines = 4).apply { gravity = Gravity.CENTER }
    private val hint = ctx.label("Back: cancel", 14f, Palette.FAINT).apply { gravity = Gravity.CENTER }

    init {
        visibility = GONE
        setBackgroundColor(Color.argb(230, 0, 0, 0))
        val card = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            background = roundRect(Palette.PANEL, ctx.dpf(10f))
            setPadding(ctx.dp(40), ctx.dp(28), ctx.dp(40), ctx.dp(22))
        }
        card.addView(heading, LinearLayout.LayoutParams(MATCH, WRAP))
        card.addView(code, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = ctx.dp(20); bottomMargin = ctx.dp(16) })
        card.addView(message, LinearLayout.LayoutParams(MATCH, WRAP))
        card.addView(hint, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = ctx.dp(22) })
        addView(card, LayoutParams(ctx.dp(if (Look.crt) 520 else 640), WRAP, Gravity.CENTER))
    }

    fun showMessage(text: String, error: Boolean = false) {
        code.visibility = GONE
        message.text = text
        message.setTextColor(if (error) Palette.BAD else Palette.TEXT)
        hint.text = if (error) "OK: try again   ·   Back: cancel" else "Back: cancel"
        visibility = VISIBLE
    }

    fun showCode(value: String, adminAddress: String) {
        code.text = value
        code.visibility = VISIBLE
        message.text = "On $adminAddress, open Screens and type this code under Link a TV. It changes every 10 minutes."
        message.setTextColor(Palette.TEXT)
        hint.text = "Back: cancel"
        visibility = VISIBLE
    }

    fun hide() {
        visibility = GONE
    }
}

/**
 * The framed layout: the channel shrinks to the top right [VIDEO_SHARE] of the screen, and the bar fills the
 * rest. Down the left: logo, name, clock and what's coming up. Along the bottom: the special that's on now,
 * taking turns if there are several, or the next one today.
 */
class BarFrameView(ctx: Context, private val images: BarImages, private val now: () -> Long) : FrameLayout(ctx) {
    private var feed: BarFeed? = null
    private var turn = 0

    private val left = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(ctx.dp(14), ctx.dp(14), ctx.dp(10), ctx.dp(8))
    }
    private val logo = ImageView(ctx).apply { scaleType = ImageView.ScaleType.FIT_START }
    private val name = ctx.label(size = 15f, color = Palette.ACCENT, bold = true, lines = 2)
    private val clock = ctx.label(size = 22f, bold = true)
    private val weatherLabel = ctx.label(size = 20f, bold = true).apply { visibility = GONE }
    private val comingTitle = ctx.label("Coming up", 12f, Palette.MUTED, bold = true)
    private val coming = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }

    private val bottom = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(ctx.dp(18), ctx.dp(6), ctx.dp(18), ctx.dp(6))
    }
    private val stripe = View(ctx).apply { setBackgroundColor(Palette.ACCENT) }
    private val specialImage = ImageView(ctx).apply { scaleType = ImageView.ScaleType.FIT_CENTER }
    private val kicker = ctx.label(size = 12f, color = Palette.ACCENT, bold = true)
    private val title = ctx.label(size = 24f, bold = true)
    private val detail = ctx.label(size = 14f, color = Palette.TEXT, lines = 1)

    private val rotate = object : Runnable {
        override fun run() {
            turn++
            draw()
            postDelayed(this, TURN_MS)
        }
    }

    init {
        visibility = GONE
        setBackgroundColor(Palette.BG)
        left.addView(logo, LinearLayout.LayoutParams(MATCH, ctx.dp(72)).apply { bottomMargin = ctx.dp(8) })
        left.addView(name, LinearLayout.LayoutParams(MATCH, WRAP))
        left.addView(clock, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = ctx.dp(4) })
        left.addView(weatherLabel, LinearLayout.LayoutParams(MATCH, WRAP))
        left.addView(comingTitle, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = ctx.dp(14); bottomMargin = ctx.dp(2) })
        left.addView(coming, LinearLayout.LayoutParams(MATCH, WRAP))
        addView(left)

        bottom.addView(specialImage, LinearLayout.LayoutParams(ctx.dp(100), MATCH).apply { rightMargin = ctx.dp(14) })
        val col = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        col.addView(kicker, LinearLayout.LayoutParams(MATCH, WRAP))
        col.addView(title, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = ctx.dp(2) })
        col.addView(detail, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = ctx.dp(2) })
        bottom.addView(col, LinearLayout.LayoutParams(0, WRAP, 1f))
        addView(bottom)
        addView(stripe)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        val videoH = (h * VIDEO_SHARE).toInt()
        val leftW = w - (w * VIDEO_SHARE).toInt()
        post {
            left.layoutParams = LayoutParams(leftW, videoH, Gravity.TOP or Gravity.START)
            bottom.layoutParams = LayoutParams(MATCH, h - videoH, Gravity.BOTTOM)
            stripe.layoutParams = LayoutParams(MATCH, context.dp(3), Gravity.TOP).apply { topMargin = videoH }
        }
    }

    fun setFeed(next: BarFeed?) {
        feed = next
        draw()
    }

    /** The temperature and an icon beside the clock, or nothing when the weather isn't known. */
    fun setWeather(w: Weather?) {
        weatherLabel.text = w?.let(::weatherText)
        weatherLabel.visibility = if (w == null) GONE else VISIBLE
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        removeCallbacks(rotate)
        if (isShown) {
            draw()
            postDelayed(rotate, TURN_MS)
        }
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        removeCallbacks(rotate)
    }

    /** Redraws everything. Called on each turn, when the feed changes, and by MainActivity's clock tick. */
    fun draw() {
        val f = feed ?: return
        if (!isShown) return
        val t = now()
        val bc = BarClock(context, f.venue.timezone)
        images.load(logo, f.venue.logo)
        name.text = f.venue.name
        clock.text = bc.time(t)

        coming.removeAllViews()
        val events = upcomingEvents(f.events, t, limit = 3)
        comingTitle.visibility = if (events.isEmpty()) GONE else VISIBLE
        events.firstOrNull()?.image?.let { url ->
            val poster = ImageView(context).apply { scaleType = ImageView.ScaleType.FIT_START }
            coming.addView(poster, LinearLayout.LayoutParams(MATCH, context.dp(84)).apply { topMargin = context.dp(6) })
            images.load(poster, url)
        }
        for (e in events) {
            coming.addView(context.label(bc.span(e.start, e.end, t), 11f, Palette.ACCENT, bold = true, lines = 2), LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = context.dp(7) })
            coming.addView(context.label(e.title, 14f, bold = true, lines = 2), LinearLayout.LayoutParams(MATCH, WRAP))
        }

        val today = specialsComingUp(f.specials, t, DAY_MS)
        val onNow = today.filter { it.second.start <= t }
        val shown = when {
            onNow.isNotEmpty() -> onNow[turn % onNow.size]
            today.isNotEmpty() -> today.first()
            else -> null
        }
        if (shown == null) {
            kicker.text = "Welcome to"
            title.text = f.venue.name
            detail.visibility = GONE
            images.load(specialImage, null)
            return
        }
        val (s, o) = shown
        kicker.text = if (o.start <= t) "On now until ${bc.time(o.end)}" else "Coming up at ${bc.whenText(o.start, t)}"
        title.text = s.title
        detail.text = s.text.orEmpty()
        detail.visibility = if (s.text.isNullOrEmpty()) GONE else VISIBLE
        images.load(specialImage, s.image)
    }

    companion object {
        /** How much of the screen's width and height the channel takes. The bar's info fills the rest. */
        const val VIDEO_SHARE = 0.82f
        private const val TURN_MS = 8_000L
        private const val DAY_MS = 24 * 3_600_000L
    }
}

/**
 * Covers a Pluto TV ad break on a bar's TV, with the sound off: the bar's upcoming events, or today's specials
 * if there are none. Keeps the ad break notice, so nobody thinks the channel has stuck.
 */
class BarBreakView(ctx: Context, private val images: BarImages, private val now: () -> Long) : LinearLayout(ctx) {
    private var feed: BarFeed? = null
    private val notice = ctx.label("Pluto ad break · show will resume · sound off", 18f, Palette.ACCENT, bold = true)
    private val logo = ImageView(ctx).apply { scaleType = ImageView.ScaleType.FIT_START }
    private val name = ctx.label(size = 30f, bold = true)
    private val heading = ctx.label(size = 22f, color = Palette.MUTED, bold = true)
    private val list = LinearLayout(ctx).apply { orientation = VERTICAL }
    private val poster = ImageView(ctx).apply { scaleType = ImageView.ScaleType.FIT_START }

    init {
        orientation = VERTICAL
        visibility = GONE
        setBackgroundColor(Palette.BG)
        val pad = ctx.dp(if (Look.crt) 16 else 48)
        setPadding(pad, ctx.dp(28), pad, ctx.dp(20))
        addView(notice, LayoutParams(MATCH, WRAP))
        val header = LinearLayout(ctx).apply { orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        header.addView(logo, LayoutParams(ctx.dp(80), ctx.dp(60)).apply { rightMargin = ctx.dp(16) })
        header.addView(name, LayoutParams(0, WRAP, 1f))
        addView(header, LayoutParams(MATCH, WRAP).apply { topMargin = ctx.dp(18) })
        addView(heading, LayoutParams(MATCH, WRAP).apply { topMargin = ctx.dp(22) })
        val row = LinearLayout(ctx).apply { orientation = HORIZONTAL }
        row.addView(list, LayoutParams(0, WRAP, 1f))
        row.addView(poster, LayoutParams(0, MATCH, 0.8f).apply { leftMargin = ctx.dp(32); topMargin = ctx.dp(14) })
        addView(row, LayoutParams(MATCH, 0, 1f))
    }

    fun setFeed(next: BarFeed?) {
        feed = next
        draw()
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        if (isShown) draw()
    }

    fun draw() {
        val f = feed ?: return
        if (!isShown) return
        val t = now()
        val bc = BarClock(context, f.venue.timezone)
        images.load(logo, f.venue.logo)
        name.text = f.venue.name
        list.removeAllViews()
        val events = upcomingEvents(f.events, t, limit = 4)
        // The soonest event with a picture, shown beside the list.
        images.load(poster, events.firstOrNull { it.image != null }?.image)
        val rows = if (events.isNotEmpty()) {
            heading.text = "Coming up"
            events.map { Triple(bc.span(it.start, it.end, t), it.title, it.description) }
        } else {
            heading.text = "Specials"
            specialsComingUp(f.specials, t, 24 * 3_600_000L).take(4).map { (s, o) -> Triple(bc.span(o.start, o.end, t), s.title, s.text) }
        }
        heading.visibility = if (rows.isEmpty()) GONE else VISIBLE
        for ((whenText, title, detail) in rows) {
            list.addView(context.label(whenText, 18f, Palette.ACCENT, bold = true), LayoutParams(MATCH, WRAP).apply { topMargin = context.dp(14) })
            list.addView(context.label(title, 28f, bold = true), LayoutParams(MATCH, WRAP).apply { topMargin = context.dp(2) })
            detail?.let { list.addView(context.label(it, 18f, Palette.MUTED, lines = 2), LayoutParams(MATCH, WRAP)) }
        }
    }
}
