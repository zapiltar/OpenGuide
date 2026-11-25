package com.openguide.tv.data

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException

// Bingo on a bar's TVs: 75-ball, one game per bar, kept on the bar server. The TV hosting the game calls the
// numbers; every TV showing the Bingo channel checks for new ones every couple of seconds.

const val BINGO_CHANNEL_ID = "openguide.bingo"
const val BINGO_BALLS = 75

/** The Bingo channel, shown in the guide of a bar's TVs when the bar has bingo on. */
fun bingoChannel() = Channel(BINGO_CHANNEL_ID, "Bingo", "", emptyList(), null, emptyList(), emptyList())

/**
 * What wins. [examples] are the squares of a 5 by 5 card (row * 5 + column) that make a win; regular bingo
 * has twelve, one for each line, and the board shows them in turn. The middle square is free.
 */
enum class BingoPattern(val id: String, val label: String, val describe: String, val examples: List<Set<Int>>) {
    REGULAR("regular", "Regular bingo", "Any line: across, down or corner to corner", buildList {
        for (i in 0 until 5) add((0 until 5).map { i * 5 + it }.toSet())
        for (i in 0 until 5) add((0 until 5).map { it * 5 + i }.toSet())
        add(setOf(0, 6, 12, 18, 24))
        add(setOf(4, 8, 12, 16, 20))
    }),
    Z("z", "The Z", "Top row, bottom row, and corner to corner between them",
        listOf(setOf(0, 1, 2, 3, 4, 8, 12, 16, 20, 21, 22, 23, 24))),
    X("x", "The X", "Both lines from corner to corner",
        listOf(setOf(0, 6, 12, 18, 24, 4, 8, 16, 20))),
    BOX("box", "Outer box", "Every square around the edge",
        listOf((0 until 25).filter { it / 5 == 0 || it / 5 == 4 || it % 5 == 0 || it % 5 == 4 }.toSet())),
    COVERALL("coverall", "Coverall", "Every number on the card", listOf((0 until 25).toSet()));

    companion object {
        fun of(id: String?) = entries.firstOrNull { it.id == id } ?: REGULAR
    }
}

/** The game as this TV should show it. [host] is whether this TV is the one calling the numbers. */
data class BingoState(
    val game: Int,
    val called: List<Int>,
    val host: Boolean,
    val hostName: String?,
    val version: Int,
    val pattern: BingoPattern = BingoPattern.REGULAR,
) {
    val last: Int? get() = called.lastOrNull()
    val finished: Boolean get() = called.size >= BINGO_BALLS
}

/** The column a number is in: B is 1 to 15, I 16 to 30, N 31 to 45, G 46 to 60 and O 61 to 75. */
fun bingoLetter(n: Int): Char = "BINGO"[((n - 1) / 15).coerceIn(0, 4)]

/** "N 34", the way callers say it. */
fun bingoCall(n: Int): String = "${bingoLetter(n)} $n"

fun parseBingo(json: String): BingoState {
    val o = JSONObject(json)
    val called = o.getJSONArray("called").let { a -> (0 until a.length()).map { a.getInt(it) } }
    return BingoState(
        game = o.getInt("game"),
        called = called,
        host = o.optBoolean("host"),
        hostName = if (o.isNull("hostName")) null else o.optString("hostName").takeIf { it.isNotEmpty() },
        version = o.optInt("version"),
        pattern = BingoPattern.of(o.optString("pattern")),
    )
}

/** Talks to the bar server about the bar's bingo game. Only checks for changes while [start]ed. */
class BingoClient(private val http: OkHttpClient, private val base: String, private val token: () -> String?) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var poller: Job? = null
    @Volatile private var etag: String? = null

    private val _state = MutableStateFlow<BingoState?>(null)
    /** The latest game, or null before the first answer from the server. */
    val state: StateFlow<BingoState?> = _state

    /** Checks for changes every [POLL_MS], while the board is on screen. Safe to call more than once. */
    fun start() {
        if (poller?.isActive == true) return
        poller = scope.launch {
            while (isActive) {
                fetch()
                delay(POLL_MS)
            }
        }
    }

    fun stop() {
        poller?.cancel()
        poller = null
    }

    /** Forgets the game, when the TV is unlinked. */
    fun reset() {
        stop()
        etag = null
        _state.value = null
    }

    private fun fetch() {
        val t = token() ?: return
        val req = Request.Builder().url("$base/api/tv/bingo")
            .header("Authorization", "Bearer $t")
            .apply { etag?.let { header("If-None-Match", it) } }
            .build()
        try {
            http.newCall(req).execute().use { res ->
                when {
                    res.code == 304 -> Unit
                    res.isSuccessful -> {
                        _state.value = parseBingo(res.body!!.string())
                        etag = res.header("ETag")
                    }
                    else -> Log.w(TAG, "Bingo returned HTTP ${res.code}")
                }
            }
        } catch (e: IOException) {
            Log.w(TAG, "Couldn't check the bingo game", e)
        } catch (e: JSONException) {
            Log.w(TAG, "Bingo game wasn't understood", e)
        }
    }

    /**
     * Does [action] ("host", "unhost", "call", "undo", "new" or "pattern", with [body]) and shows the result
     * straight away. Returns null if it worked, or a message saying why not.
     */
    suspend fun act(action: String, body: JSONObject = JSONObject()): String? = withContext(Dispatchers.IO) {
        val t = token() ?: return@withContext "This TV isn't linked to a bar"
        val req = Request.Builder().url("$base/api/tv/bingo/$action")
            .header("Authorization", "Bearer $t")
            .post(body.toString().toRequestBody(JSON))
            .build()
        try {
            http.newCall(req).execute().use { res ->
                val text = res.body?.string().orEmpty()
                if (res.isSuccessful) {
                    _state.value = parseBingo(text)
                    // The next check fetches the whole game again, so its ETag matches what's shown.
                    etag = null
                    null
                } else {
                    runCatching { JSONObject(text).getString("error") }.getOrNull() ?: "The bar server returned HTTP ${res.code}"
                }
            }
        } catch (e: IOException) {
            Log.w(TAG, "Bingo $action failed", e)
            "Couldn't reach the bar server"
        } catch (e: JSONException) {
            Log.w(TAG, "Bingo $action answer wasn't understood", e)
            "The bar server sent something unexpected"
        }
    }

    private companion object {
        const val TAG = "Bingo"
        const val POLL_MS = 2_000L
        val JSON = "application/json; charset=utf-8".toMediaType()
    }
}
