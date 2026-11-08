package com.openguide.tv.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.TextPaint
import android.text.TextUtils
import android.util.Log
import android.view.View
import com.openguide.tv.data.GuideRow
import kotlin.random.Random

/**
 * The guide channel: what's on now and next, scrolling slowly up the screen for as long as you leave
 * it on. Drawn on a canvas like the guide itself, because a stick can't scroll hundreds of nested views.
 */
class GuideChannelView(ctx: Context) : View(ctx) {
    private var rows: List<GuideRow> = emptyList()
    /** Each row's text once fitted to the screen, so it's only worked out the first time it's drawn. */
    private var fitted: Array<Array<String>?> = emptyArray()
    private var scroll = 0f
    private var lastFrame = 0L
    private var clockText = ""
    private var clockMinute = -1L

    private val headerH = ctx.dp(38)
    private val rowH = ctx.dp(78)
    private val pad = ctx.dpf(12f)
    private val speed = ctx.dpf(SCROLL_DP_PER_SECOND)
    private val bevel = ctx.dpf(1.5f)
    private val fill = Paint()
    private val namePaint = text(18f, Look.boldFace)
    private val linePaint = text(16.5f, Look.plainFace)
    private val headerPaint = text(19f, Look.boldFace)

    init {
        visibility = GONE
    }

    private fun text(sp: Float, face: Typeface) = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = sp * resources.displayMetrics.scaledDensity
        typeface = face
        textScaleX = Look.textScaleX
        setShadowLayer(1f, context.dpf(1.5f), context.dpf(1.5f), Color.BLACK)
    }

    fun setRows(next: List<GuideRow>) {
        rows = next
        fitted = arrayOfNulls(next.size)
        invalidate()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        fitted = arrayOfNulls(rows.size)
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        lastFrame = 0
        if (visibility == VISIBLE) invalidate()
    }

    override fun onDraw(c: Canvas) {
        c.drawColor(Palette.BG)
        val listH = height - headerH
        val total = rows.size * rowH.toFloat()
        val moving = total > listH
        val now = SystemClock.uptimeMillis()
        if (moving) {
            if (lastFrame != 0L) scroll = (scroll + (now - lastFrame) * speed / 1000f) % total
            lastFrame = now
        } else {
            scroll = 0f
        }

        if (rows.isEmpty()) {
            linePaint.color = Palette.MUTED
            val message = "Listings are still loading."
            c.drawText(message, (width - linePaint.measureText(message)) / 2, height / 2f, linePaint)
        } else {
            val saved = c.save()
            c.clipRect(0, headerH, width, height)
            // Whole pixels, because a line that's blended across two scan lines shimmers on a tube.
            val top = scroll.toInt()
            var i = top / rowH
            var y = headerH - top % rowH
            while (y < height && (moving || i < rows.size)) {
                drawRow(c, i % rows.size, y.toFloat())
                i++
                y += rowH
            }
            c.restoreToCount(saved)
        }
        drawHeader(c)
        if (moving && visibility == VISIBLE) postInvalidateOnAnimation()
    }

    private fun drawHeader(c: Canvas) {
        fill.color = Palette.HEADER
        c.drawRect(0f, 0f, width.toFloat(), headerH.toFloat(), fill)
        val base = headerH * 0.7f
        headerPaint.color = Palette.ACCENT
        // Centred, as the channel number appears at the top left.
        val title = "GUIDE CHANNEL"
        c.drawText(title, (width - headerPaint.measureText(title)) / 2, base, headerPaint)
        val wall = System.currentTimeMillis()
        if (wall / 60_000 != clockMinute) {
            clockMinute = wall / 60_000
            clockText = timeOf(context, wall)
        }
        headerPaint.color = Palette.TEXT
        c.drawText(clockText, width - pad - headerPaint.measureText(clockText), base, headerPaint)
    }

    private fun drawRow(c: Canvas, index: Int, y: Float) {
        drawBevel(c, fill, 0f, y + 1, width.toFloat(), y + rowH - 1, if (index % 2 == 0) Palette.PANEL else Palette.CELL, bevel)
        val lines = fitted[index] ?: fit(rows[index]).also { fitted[index] = it }
        namePaint.color = Palette.ACCENT
        c.drawText(lines[0], pad, y + rowH * 0.31f, namePaint)
        linePaint.color = Palette.TEXT
        c.drawText(lines[1], pad, y + rowH * 0.62f, linePaint)
        if (lines[2].isNotEmpty()) {
            linePaint.color = Palette.MUTED
            c.drawText(lines[2], pad, y + rowH * 0.89f, linePaint)
        }
    }

    private fun fit(row: GuideRow): Array<String> {
        val avail = width - pad * 2
        fun cut(s: String, paint: TextPaint) = TextUtils.ellipsize(s, paint, avail, TextUtils.TruncateAt.END).toString()
        val next = row.next?.let { title -> "${row.nextAt?.let { timeOf(context, it) }.orEmpty()}  $title" }
        return arrayOf(
            cut("${row.number}  ${row.name}", namePaint),
            cut("Now  ${row.now}", linePaint),
            next?.let { cut(it, linePaint) }.orEmpty(),
        )
    }

    private companion object {
        const val SCROLL_DP_PER_SECOND = 28f
    }
}

/**
 * Analog snow for a channel change, which also hides the wait for the new stream. No two bursts look
 * alike: grain size, brightness, roll and a dark hum bar all vary, as they did with a real tuner.
 * The noise frames are made once, so drawing costs a stick next to nothing.
 */
class StaticView(ctx: Context) : View(ctx) {
    private val frames: List<Bitmap> by lazy {
        List(FRAME_COUNT) { i -> noiseFrame(GRAINS[i % GRAINS.size]) }
    }
    private val sound by lazy { StaticSound() }
    private val paint = Paint() // no filtering: the noise should stay coarse
    private val shade = Paint()
    private val target = Rect()
    private var frame = 0
    private var earliestEnd = 0L

    // What this burst looks like, picked afresh each time.
    private var darkness = 0
    private var roll = 0f
    private var rollSpeed = 0f
    private var barAt = 0f
    private var barSpeed = 0f
    private var barStrength = 0

    /** Whether the hiss is playing right now, or null if this device can't play it. */
    val soundPlaying: Boolean? get() = sound.playing

    private val nextFrame = object : Runnable {
        override fun run() {
            frame = (frame + 1 + Random.nextInt(FRAME_COUNT - 1)) % FRAME_COUNT
            roll = (roll + rollSpeed) % 1f
            barAt = (barAt + barSpeed) % 1.4f
            invalidate()
            // An uneven rate reads as noise; a steady one reads as an animation.
            postDelayed(this, Random.nextLong(FRAME_MS_MIN, FRAME_MS_MAX + 1))
        }
    }
    private val stop = Runnable { cancel() }

    init {
        visibility = GONE
    }

    private fun noiseFrame(grain: Pair<Int, Int>): Bitmap {
        val (w, h) = grain
        val pixels = IntArray(w * h)
        val streak = if (Random.nextInt(3) == 0) Random.nextInt(h) else -1
        for (y in 0 until h) {
            // Each line is a little brighter or darker than the last, as snow is on a real set.
            var band = Random.nextInt(-28, 29)
            if (streak >= 0 && y in streak..streak + h / 40) band += 70
            for (x in 0 until w) {
                val v = (Random.nextInt(256) + band).coerceIn(0, 255)
                pixels[y * w + x] = Color.rgb(v, v, v)
            }
        }
        return Bitmap.createBitmap(pixels, w, h, Bitmap.Config.RGB_565)
    }

    /**
     * Runs until [finish], but gives up after a while so a slow stream isn't hidden by snow forever.
     * @param withSound plays the hiss too.
     */
    fun start(withSound: Boolean) {
        removeCallbacks(stop)
        removeCallbacks(nextFrame)
        earliestEnd = SystemClock.uptimeMillis() + SHORTEST_MS
        darkness = Random.nextInt(0, 90)
        roll = Random.nextFloat()
        rollSpeed = if (Random.nextBoolean()) Random.nextFloat() * 0.06f else 0f
        barAt = Random.nextFloat()
        barSpeed = 0.01f + Random.nextFloat() * 0.04f
        barStrength = Random.nextInt(40, 130)
        visibility = VISIBLE
        post(nextFrame)
        postDelayed(stop, LONGEST_MS)
        if (withSound) sound.start() else sound.stop()
    }

    /** The picture is ready. Still runs for long enough to read as a burst rather than a glitch. */
    fun finish() {
        if (visibility != VISIBLE) return
        removeCallbacks(stop)
        postDelayed(stop, (earliestEnd - SystemClock.uptimeMillis()).coerceAtLeast(0))
    }

    fun cancel() {
        removeCallbacks(stop)
        removeCallbacks(nextFrame)
        visibility = GONE
        sound.stop()
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        cancel()
        sound.release()
    }

    override fun onDraw(c: Canvas) {
        val w = width
        val h = height
        // The picture rolls: drawn twice, wrapped around, like a set losing vertical hold.
        val dy = (roll * h).toInt()
        target.set(0, dy - h, w, dy)
        c.drawBitmap(frames[frame], null, target, paint)
        target.set(0, dy, w, dy + h)
        c.drawBitmap(frames[(frame + 1) % FRAME_COUNT], null, target, paint)

        // Brightness flickers from frame to frame around this burst's level.
        shade.color = Color.argb((darkness + Random.nextInt(-20, 21)).coerceIn(0, 140), 0, 0, 0)
        c.drawRect(0f, 0f, w.toFloat(), h.toFloat(), shade)

        // The dark hum bar drifting down the screen.
        val barH = h * 0.22f
        val top = (barAt - 0.2f) * h
        shade.color = Color.argb(barStrength, 0, 0, 0)
        c.drawRect(0f, top, w.toFloat(), top + barH, shade)
    }

    private companion object {
        /** Coarser and finer grain, so frames don't all look alike. */
        val GRAINS = listOf(128 to 96, 176 to 132, 224 to 168, 160 to 120)
        const val FRAME_COUNT = 10
        const val FRAME_MS_MIN = 35L
        const val FRAME_MS_MAX = 70L
        const val SHORTEST_MS = 350L
        const val LONGEST_MS = 5_000L
    }
}

/**
 * The hiss, made here rather than shipped as a file. It loops while the snow shows and fades in and
 * out, since a hard start or stop clicks.
 */
private class StaticSound {
    private val handler = Handler(Looper.getMainLooper())
    private var fadeStep = 0
    private val track: AudioTrack? = try {
        val pcm = staticHiss(SAMPLE_RATE, LOOP_SECONDS, Random.nextLong())
        @Suppress("DEPRECATION")
        AudioTrack(
            AudioManager.STREAM_MUSIC, SAMPLE_RATE, AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT, pcm.size * 2, AudioTrack.MODE_STATIC,
        ).takeIf { it.state == AudioTrack.STATE_INITIALIZED }?.apply {
            write(pcm, 0, pcm.size)
            setLoopPoints(0, pcm.size, -1)
        }
    } catch (e: Exception) {
        Log.w("StaticSound", "No sound for static", e)
        null
    }

    val playing: Boolean? get() = track?.let { it.playState == AudioTrack.PLAYSTATE_PLAYING }

    private val fade = object : Runnable {
        override fun run() {
            val t = track ?: return
            fadeStep--
            if (fadeStep <= 0) {
                t.pause()
                return
            }
            t.setVolume(VOLUME * fadeStep / FADE_STEPS)
            handler.postDelayed(this, FADE_STEP_MS)
        }
    }

    fun start() {
        val t = track ?: return
        handler.removeCallbacks(fade)
        try {
            if (t.playState != AudioTrack.PLAYSTATE_PLAYING) {
                t.setVolume(VOLUME)
                t.play()
            } else {
                t.setVolume(VOLUME)
            }
        } catch (e: IllegalStateException) {
            Log.w("StaticSound", "Couldn't play static", e)
        }
    }

    fun stop() {
        val t = track ?: return
        if (t.playState != AudioTrack.PLAYSTATE_PLAYING) return
        handler.removeCallbacks(fade)
        fadeStep = FADE_STEPS
        handler.post(fade)
    }

    fun release() {
        handler.removeCallbacks(fade)
        track?.release()
    }

    private companion object {
        const val SAMPLE_RATE = 22_050
        const val LOOP_SECONDS = 2f
        const val VOLUME = 0.45f
        const val FADE_STEPS = 5
        const val FADE_STEP_MS = 25L
    }
}

/**
 * TV hiss as 16-bit samples: white noise with its loudness wandering slowly, a little of the low end
 * that gives it body, and the odd crackle. The two ends are blended so it loops without a seam.
 */
fun staticHiss(sampleRate: Int, seconds: Float, seed: Long): ShortArray {
    val rnd = Random(seed)
    val n = (sampleRate * seconds).toInt()
    val raw = FloatArray(n)
    var low = 0f
    var level = 0.85f
    var target = 0.85f
    for (i in 0 until n) {
        if (i % (sampleRate / 20) == 0) target = 0.65f + rnd.nextFloat() * 0.35f
        level += (target - level) * 0.0015f
        val white = rnd.nextFloat() * 2f - 1f
        low += (white - low) * 0.08f
        var s = (white * 0.75f + low * 1.6f) * level
        if (rnd.nextInt(sampleRate / 6) == 0) s += if (rnd.nextBoolean()) 0.9f else -0.9f
        raw[i] = s
    }
    // Crossfade the tail into the head so the loop point can't be heard.
    val blend = sampleRate / 20
    for (i in 0 until blend) {
        val k = i.toFloat() / blend
        raw[i] = raw[i] * k + raw[n - blend + i] * (1 - k)
    }
    val out = raw.copyOf(n - blend)
    val peak = out.maxOf { kotlin.math.abs(it) }.coerceAtLeast(1e-6f)
    return ShortArray(out.size) { (out[it] / peak * 0.8f * Short.MAX_VALUE).toInt().toShort() }
}
