package com.openguide.tv.ui

import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.ViewGroup
import android.view.animation.OvershootInterpolator
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.openguide.tv.data.BINGO_BALLS
import com.openguide.tv.data.BingoState
import com.openguide.tv.data.bingoCall
import com.openguide.tv.data.bingoLetter

private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
private const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT

/**
 * The Bingo channel: the last number called in a big ball on the left, and the whole 75-ball board on the
 * right with every called number lit. Along the bottom, what the remote does on this TV.
 */
class BingoView(ctx: Context) : FrameLayout(ctx) {
    private var shown: BingoState? = null

    private val ball = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
    }
    private val ballLetter = ctx.label(size = 40f, color = Palette.ON_ACCENT, bold = true).apply { gravity = Gravity.CENTER }
    private val ballNumber = ctx.label(size = 104f, color = Palette.ON_ACCENT, bold = true).apply { gravity = Gravity.CENTER }
    private val count = ctx.label(size = 22f, bold = true).apply { gravity = Gravity.CENTER }
    private val before = ctx.label(size = 18f, color = Palette.MUTED, lines = 2).apply { gravity = Gravity.CENTER }
    private val hint = ctx.label(size = 16f, color = Palette.MUTED, lines = 2)
    private val cells = arrayOfNulls<TextView>(BINGO_BALLS + 1)

    init {
        setBackgroundColor(Palette.BG)
        visibility = GONE
        val pad = ctx.dp(if (Look.crt) 14 else 36)
        val page = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, ctx.dp(24), pad, ctx.dp(16))
        }
        val main = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }

        // Left: the title, the ball and what came before.
        val left = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }
        left.addView(ctx.label("BINGO", 34f, Palette.ACCENT, bold = true).apply { gravity = Gravity.CENTER; letterSpacing = 0.2f },
            LinearLayout.LayoutParams(MATCH, WRAP))
        ball.background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Palette.ACCENT)
            setStroke(ctx.dp(6), Palette.TEXT)
        }
        ball.addView(ballLetter, LinearLayout.LayoutParams(WRAP, WRAP))
        ball.addView(ballNumber, LinearLayout.LayoutParams(WRAP, WRAP))
        val size = ctx.dp(if (Look.crt) 170 else 230)
        left.addView(ball, LinearLayout.LayoutParams(size, size).apply { topMargin = ctx.dp(14); bottomMargin = ctx.dp(14) })
        left.addView(count, LinearLayout.LayoutParams(MATCH, WRAP))
        left.addView(before, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = ctx.dp(8) })
        main.addView(left, LinearLayout.LayoutParams(0, WRAP, 0.32f).apply { rightMargin = ctx.dp(28) })

        // Right: five rows of fifteen, each starting with its letter.
        val board = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        val gap = ctx.dp(3)
        for (row in 0 until 5) {
            val line = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
            line.addView(ctx.label("BINGO"[row].toString(), 30f, Palette.ACCENT, bold = true).apply { gravity = Gravity.CENTER },
                LinearLayout.LayoutParams(0, MATCH, 1.2f))
            for (col in 0 until 15) {
                val n = row * 15 + col + 1
                val cell = ctx.label(n.toString(), 20f, Palette.FAINT, bold = true).apply { gravity = Gravity.CENTER }
                cells[n] = cell
                line.addView(cell, LinearLayout.LayoutParams(0, MATCH, 1f).apply { setMargins(gap, gap, gap, gap) })
            }
            board.addView(line, LinearLayout.LayoutParams(MATCH, 0, 1f))
        }
        main.addView(board, LinearLayout.LayoutParams(0, ctx.dp(if (Look.crt) 250 else 360), 0.68f))

        page.addView(main, LinearLayout.LayoutParams(MATCH, 0, 1f))
        page.addView(hint, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = ctx.dp(12) })
        addView(page, LayoutParams(MATCH, MATCH))
        draw(null)
    }

    fun setState(state: BingoState?) {
        val old = shown
        shown = state
        draw(state)
        // A new number pops in, but not when the board first appears or a number is taken back.
        val last = state?.last
        if (last != null && old != null && old.game == state.game && state.called.size > old.called.size) pop()
    }

    private fun pop() {
        ball.animate().cancel()
        ball.scaleX = 0.4f
        ball.scaleY = 0.4f
        ball.animate().scaleX(1f).scaleY(1f).setDuration(450).setInterpolator(OvershootInterpolator(2f)).start()
    }

    private fun draw(s: BingoState?) {
        val called = s?.called.orEmpty().toSet()
        val last = s?.last
        val radius = context.dpf(6f)
        for (n in 1..BINGO_BALLS) {
            val cell = cells[n] ?: continue
            when {
                n == last -> {
                    cell.background = roundRect(Palette.ACCENT, radius, Palette.TEXT, context.dp(3))
                    cell.setTextColor(Palette.ON_ACCENT)
                }
                n in called -> {
                    cell.background = roundRect(Palette.ACCENT, radius)
                    cell.setTextColor(Palette.ON_ACCENT)
                }
                else -> {
                    cell.background = roundRect(Palette.CELL_EMPTY, radius)
                    cell.setTextColor(Palette.FAINT)
                }
            }
        }
        if (last == null) {
            ballLetter.text = ""
            ballNumber.text = "?"
            count.text = if (s == null) "Loading the game…" else "Waiting for the first number"
        } else {
            ballLetter.text = bingoLetter(last).toString()
            ballNumber.text = last.toString()
            count.text = if (s.finished) "All $BINGO_BALLS numbers called" else "Number ${s.called.size} of $BINGO_BALLS"
        }
        val earlier = s?.called.orEmpty().dropLast(1).takeLast(4).reversed()
        before.text = if (earlier.isEmpty()) "" else "Before that: " + earlier.joinToString("   ") { bingoCall(it) }
        hint.text = when {
            s == null -> ""
            s.host && s.finished -> "You're hosting.  Hold OK to start a new game."
            s.host -> "You're hosting.  OK: call the next number.  Hold OK: take one back, or start a new game."
            s.hostName != null -> "Numbers are being called on ${s.hostName}.  Hold OK to host from this TV instead."
            else -> "No one is hosting yet.  Hold OK and choose Host bingo to start calling numbers."
        }
        hint.setTextColor(if (s?.host == true) Palette.ACCENT else Palette.MUTED)
    }
}
