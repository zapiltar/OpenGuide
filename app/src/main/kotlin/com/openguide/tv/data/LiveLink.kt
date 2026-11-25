package com.openguide.tv.data

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * Keeps a WebSocket open to the bar server while [start]ed, so the server can tell this TV about changes the
 * moment they're sent instead of the TV asking every few minutes. Pings now and then to notice a connection
 * that has quietly died, as TV Wi-Fi sometimes does, and reconnects, waiting a little longer each time it fails.
 *
 * [onOpen] runs each time it connects, which is the moment to catch up on anything missed while it wasn't.
 * [onRejected] gets the HTTP status when the server refuses the connection, such as 401 for an unlinked TV.
 */
class LiveLink(
    private val http: OkHttpClient,
    private val url: String,
    private val token: () -> String?,
    private val onOpen: () -> Unit,
    private val onMessage: (String) -> Unit,
    private val onRejected: (Int) -> Unit = {},
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loop: Job? = null
    @Volatile private var socket: WebSocket? = null
    @Volatile private var live = false
    @Volatile private var lastHeard = 0L

    /** Safe to call more than once. */
    fun start() {
        if (loop?.isActive == true) return
        loop = scope.launch {
            var retryAt = 0L
            var backoff = RETRY_MIN_MS
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
                    if (now - lastHeard > SILENT_MS) {
                        Log.i(TAG, "Live connection went quiet; reconnecting")
                        socket?.cancel()
                        socket = null
                        live = false
                    }
                }
                delay(TICK_MS)
            }
        }
    }

    fun stop() {
        loop?.cancel()
        loop = null
        socket?.close(1000, "Stopped")
        socket = null
        live = false
    }

    private fun connect() {
        val t = token() ?: return
        val req = Request.Builder().url(url).header("Authorization", "Bearer $t").build()
        socket = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (webSocket !== socket) return
                Log.i(TAG, "Live connection open")
                lastHeard = System.currentTimeMillis()
                live = true
                onOpen()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (webSocket !== socket) return
                lastHeard = System.currentTimeMillis()
                if (text != "pong") onMessage(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                closed(webSocket)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = closed(webSocket)

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "Live connection failed${response?.let { " (HTTP ${it.code})" } ?: ""}", t)
                closed(webSocket)
                response?.code?.let(onRejected)
            }

            private fun closed(webSocket: WebSocket) {
                if (webSocket !== socket) return
                socket = null
                live = false
            }
        })
    }

    private companion object {
        const val TAG = "LiveLink"
        const val TICK_MS = 1_000L
        const val PING_MS = 50_000L
        const val SILENT_MS = 130_000L
        const val RETRY_MIN_MS = 2_000L
        const val RETRY_MAX_MS = 5 * 60_000L
    }
}
