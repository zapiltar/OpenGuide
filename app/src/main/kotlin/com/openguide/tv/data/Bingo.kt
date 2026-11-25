package com.openguide.tv.data

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException

// Bingo on a bar's TVs: 75-ball, one game per bar, kept on the bar server. The TV hosting the game calls the
// numbers; every TV showing the Bingo channel hears about each one the moment it's called.

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

/**
 * Talks to the bar server about the bar's bingo game. While [start]ed, it keeps a WebSocket open to the bar's
 * bingo room, which sends each change the moment it happens. If that connection can't be made or drops, it
 * checks every few seconds instead, and keeps trying to reconnect.
 */
class BingoClient(private val http: OkHttpClient, private val base: String, private val token: () -> String?) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loop: Job? = null
    @Volatile private var etag: String? = null
    @Volatile private var socket: WebSocket? = null
    /** Whether [socket] is open and the server has been heard from recently. */
    @Volatile private var live = false
    @Volatile private var lastHeard = 0L

    private val _state = MutableStateFlow<BingoState?>(null)
    /** The latest game, or null before the first answer from the server. */
    val state: StateFlow<BingoState?> = _state

    private val _errors = MutableSharedFlow<String>(extraBufferCapacity = 4)
    /** Why an action sent over the live connection didn't work, like "Only the TV hosting bingo can do that". */
    val errors: SharedFlow<String> = _errors

    /** Connects while the board is on screen. Safe to call more than once. */
    fun start() {
        if (loop?.isActive == true) return
        loop = scope.launch {
            var retryAt = 0L
            var backoff = RETRY_MIN_MS
            var lastPoll = 0L
            var lastPing = 0L
            while (isActive) {
                val now = System.currentTimeMillis()
                if (socket == null && now >= retryAt) {
                    connect()
                    retryAt = now + backoff
                    backoff = minOf(backoff * 2, RETRY_MAX_MS)
                }
                if (live) {
                    backoff = RETRY_MIN_MS
                    if (now - lastPing >= PING_MS) {
                        socket?.send("ping")
                        lastPing = now
                    }
                    // Nothing back, not even "pong": the connection has quietly died, as TV Wi-Fi sometimes does.
                    if (now - lastHeard > SILENT_MS) {
                        Log.i(TAG, "Live connection went quiet; reconnecting")
                        drop()
                    }
                } else if (now - lastPoll >= FALLBACK_POLL_MS) {
                    fetch()
                    lastPoll = now
                }
                delay(TICK_MS)
            }
        }
    }

    fun stop() {
        loop?.cancel()
        loop = null
        socket?.close(1000, "Left the Bingo channel")
        socket = null
        live = false
    }

    /** Forgets the game, when the TV is unlinked. */
    fun reset() {
        stop()
        etag = null
        _state.value = null
    }

    private fun drop() {
        socket?.cancel()
        socket = null
        live = false
    }

    private fun connect() {
        val t = token() ?: return
        val req = Request.Builder().url("$base/api/tv/bingo/live").header("Authorization", "Bearer $t").build()
        socket = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (webSocket !== socket) return
                Log.i(TAG, "Live connection open")
                lastHeard = System.currentTimeMillis()
                live = true
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (webSocket !== socket) return
                lastHeard = System.currentTimeMillis()
                if (text == "pong") return
                try {
                    val o = JSONObject(text)
                    if (o.has("error")) {
                        _errors.tryEmit(o.getString("error"))
                        return
                    }
                    _state.value = parseBingo(text)
                    // A later check (if the connection drops) fetches the whole game, to match what's shown.
                    etag = null
                } catch (e: JSONException) {
                    Log.w(TAG, "Live bingo message wasn't understood", e)
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                closed(webSocket)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = closed(webSocket)

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "Live connection failed${response?.let { " (HTTP ${it.code})" } ?: ""}", t)
                closed(webSocket)
            }

            private fun closed(webSocket: WebSocket) {
                if (webSocket !== socket) return
                socket = null
                live = false
            }
        })
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
     * Does [action] ("host", "unhost", "call", "undo", "new" or "pattern", with [body]). Over the live connection
     * when it's open, which is quickest: the result arrives like any other change, and a problem comes through
     * [errors]. Otherwise over HTTP, returning null if it worked or a message saying why not.
     *
     * Calls, undos and new games say which version of the game they were made from, so the server ignores a
     * repeat of one already done, as when OK is pressed twice quickly.
     */
    suspend fun act(action: String, body: JSONObject = JSONObject()): String? = withContext(Dispatchers.IO) {
        if (action in GUARDED) _state.value?.let { body.put("version", it.version) }
        val ws = socket
        if (live && ws != null && ws.send(JSONObject(body.toString()).put("action", action).toString())) return@withContext null
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
        const val TICK_MS = 1_000L
        val GUARDED = setOf("call", "undo", "new")
        /** How often to check while there's no live connection. */
        const val FALLBACK_POLL_MS = 3_000L
        const val PING_MS = 25_000L
        const val SILENT_MS = 70_000L
        const val RETRY_MIN_MS = 2_000L
        const val RETRY_MAX_MS = 30_000L
        val JSON = "application/json; charset=utf-8".toMediaType()
    }
}
