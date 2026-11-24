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
        background = roundRect(Palette.PANEL, ctx.dpf(8f), Palette.ACCENT, ctx.dp(2))
        setPadding(ctx.dp(20), ctx.dp(14), ctx.dp(24), ctx.dp(14))
        elevation = ctx.dpf(6f)
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
            takeoverKicker.text = barName
            takeoverTitle.text = s.title
            takeoverText.text = s.text.orEmpty()
            takeoverText.visibility = if (s.text.isNullOrEmpty()) GONE else VISIBLE
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

    private val advance = object : Runnable {
        override fun run() {
            page = (page + 1) % pageCount
            draw()
            postDelayed(this, PAGE_MS)
        }
    }

    init {
        orientation = VERTICAL
        visibility = GONE
        setBackgroundColor(Palette.BG)
        val pad = ctx.dp(if (Look.crt) 16 else 40)
        setPadding(pad, ctx.dp(24), pad, ctx.dp(16))
        val header = LinearLayout(ctx).apply { orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
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
            postDelayed(advance, PAGE_MS)
        }
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        removeCallbacks(advance)
    }

    private sealed class Page {
        class Menu(val menu: BarMenu) : Page()
        class Events(val events: List<BarEvent>) : Page()
        class Specials(val specials: List<Pair<Special, Occurrence>>) : Page()
        object Empty : Page()
    }

    private fun pages(f: BarFeed, t: Long): List<Page> = buildList {
        val specials = specialsComingUp(f.specials, t, DAY_MS)
        if (specials.isNotEmpty()) add(Page.Specials(specials))
        f.menus.forEach { add(Page.Menu(it)) }
        val events = upcomingEvents(f.events, t)
        if (events.isNotEmpty()) add(Page.Events(events))
        if (isEmpty()) add(Page.Empty)
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
        when (val p = all[page]) {
            is Page.Menu -> menuPage(p.menu)
            is Page.Events -> listPage("Coming up", p.events.map { e -> Triple(bc.span(e.start, e.end, t), e.title, e.description) })
            is Page.Specials -> listPage("Specials", p.specials.map { (s, o) -> Triple(bc.span(o.start, o.end, t), s.title, s.text) })
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
        val itemCount = m.sections.sumOf { it.items.size + 1 }
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
            heights[i] += section.items.size + 1
            val col = cols[i]
            section.title?.let {
                col.addView(context.label(it, size + 2f, Palette.ACCENT, bold = true), LayoutParams(MATCH, WRAP).apply { topMargin = context.dp(6); bottomMargin = context.dp(6) })
            }
            for (item in section.items) {
                val row = LinearLayout(context).apply { orientation = HORIZONTAL }
                row.addView(context.label(item.name, size, bold = true), LayoutParams(0, WRAP, 1f))
                item.price?.let { row.addView(context.label(it, size, Palette.ACCENT, bold = true), LayoutParams(WRAP, WRAP).apply { leftMargin = context.dp(12) }) }
                col.addView(row, LayoutParams(MATCH, WRAP).apply { topMargin = context.dp(4) })
                item.description?.let { col.addView(context.label(it, size - 4f, Palette.MUTED, lines = 2), LayoutParams(MATCH, WRAP)) }
            }
        }
        val row = LinearLayout(context).apply { orientation = HORIZONTAL }
        cols.forEachIndexed { i, c ->
            row.addView(c, LayoutParams(0, WRAP, 1f).apply { if (i > 0) leftMargin = context.dp(36) })
        }
        body.addView(row, FrameLayout.LayoutParams(MATCH, WRAP))
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
        const val PAGE_MS = 12_000L
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
