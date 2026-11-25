package com.openguide.tv.data

import android.content.Context
import android.util.Log
import com.openguide.tv.BuildConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.IOException

data class Pairing(val code: String, val secret: String, val expiresAt: Long, val pollSeconds: Int)

sealed class PairStatus {
    object Waiting : PairStatus()
    /** The code expired or was never valid, so ask for a new one. */
    object Gone : PairStatus()
    data class Linked(val token: String, val screenName: String, val venueName: String) : PairStatus()
}

/**
 * Links this TV to a bar and keeps that bar's feed up to date. It fetches the feed on start, when the bar
 * sends its changes (over a live connection to the bar server, see [LiveLink]), on request, and once an hour
 * in case a send was missed. The hourly check also moves the specials' week of times along.
 * Most checks are a cheap "nothing changed" answer.
 * The last feed is saved, so a linked TV shows its bar straight away after a restart, even offline.
 * Does nothing unless the build names a Bar Mode server (BuildConfig.BAR_API).
 */
class BarMode(ctx: Context, private val http: OkHttpClient, private val prefs: Prefs) {
    val available: Boolean = BuildConfig.BAR_API.isNotBlank()
    private val base = BuildConfig.BAR_API.trimEnd('/')
    private val cacheFile = File(ctx.filesDir, "bar_feed.json")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Mutex()
    private var poller: Job? = null
    private var etag: String? = null

    private val _feed = MutableStateFlow<BarFeed?>(null)
    /** The linked bar's feed, or null when this TV isn't linked or hasn't got one yet. */
    val feed: StateFlow<BarFeed?> = _feed

    private val _weather = MutableStateFlow<Weather?>(null)
    /** The weather at the bar, fetched only while the screen can be framed, since that's the only place it shows. */
    val weather: StateFlow<Weather?> = _weather
    /** When the weather was last fetched, or 0 to fetch it at the next chance. */
    @Volatile private var weatherAt = 0L

    /** The bar's bingo game. */
    val bingo = BingoClient(http, base) { prefs.barToken }

    /** How far this TV's clock is behind the server's, so specials start on time even if the TV's clock is off. */
    @Volatile var clockOffset = 0L
        private set

    val linked: Boolean get() = available && prefs.barToken != null
    val screenName: String? get() = prefs.barScreenName

    /** Where staff manage the bar, as shown on the TV while linking. */
    val adminAddress: String get() = base.removePrefix("https://").removePrefix("http://") + "/admin"

    fun now(): Long = System.currentTimeMillis() + clockOffset

    init {
        if (linked) loadCached()
    }

    private fun loadCached() {
        try {
            if (cacheFile.exists()) {
                val text = cacheFile.readText()
                _feed.value = parseBarFeed(text)
                etag = prefs.etag(ETAG_KEY)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Saved bar feed is unreadable", e)
            cacheFile.delete()
            prefs.setEtag(ETAG_KEY, null)
        }
    }

    /** Told by the bar server when the bar sends its changes, or when this TV is unlinked. */
    private val link = LiveLink(
        http,
        "$base/api/tv/live",
        token = { prefs.barToken },
        // Connecting (again) is when to catch up on anything sent while this TV was off or offline.
        onOpen = { scope.launch { refresh() } },
        onMessage = { if (it == "refresh") refreshNow() },
        // Refused: if it's because this TV was unlinked, fetching the feed finds that out and forgets the bar.
        onRejected = { code -> if (code == 401) scope.launch { refresh() } },
    )
    private var weatherLoop: Job? = null

    /** Starts listening for changes, if linked. Safe to call more than once. */
    fun start() {
        if (!linked || poller?.isActive == true) return
        poller = scope.launch {
            while (isActive && linked) {
                refresh()
                delay(POLL_MS)
            }
        }
        link.start()
        weatherLoop = scope.launch {
            while (isActive && linked) {
                refreshWeather()
                delay(60_000)
            }
        }
    }

    /** Checks for changes now, without waiting for the next scheduled check. */
    fun refreshNow() {
        scope.launch {
            refresh()
            weatherAt = 0L
            refreshWeather()
        }
    }

    private suspend fun refresh() = lock.withLock {
        val token = prefs.barToken ?: return@withLock
        val req = Request.Builder().url("$base/api/tv/feed")
            .header("Authorization", "Bearer $token")
            .header("X-App-Version", BuildConfig.VERSION_NAME)
            .apply { etag?.let { header("If-None-Match", it) } }
            .build()
        try {
            http.newCall(req).execute().use { res ->
                val sentAt = System.currentTimeMillis()
                res.header("X-Server-Time")?.toLongOrNull()?.let { clockOffset = it - sentAt }
                when {
                    res.code == 304 -> Unit
                    res.code == 401 -> {
                        Log.i(TAG, "Server says this screen was unlinked")
                        forget()
                    }
                    res.isSuccessful -> {
                        val text = res.body!!.string()
                        val next = parseBarFeed(text)
                        cacheFile.writeText(text)
                        etag = res.header("ETag")
                        prefs.setEtag(ETAG_KEY, etag)
                        prefs.barScreenName = next.screenName
                        _feed.value = next
                        // The bar changed something, maybe its ZIP code, so the weather is fetched again too.
                        weatherAt = 0L
                    }
                    else -> Log.w(TAG, "Bar feed returned HTTP ${res.code}")
                }
            }
        } catch (e: IOException) {
            Log.w(TAG, "Couldn't reach the bar server; keeping the last feed", e)
        } catch (e: JSONException) {
            Log.w(TAG, "Bar feed wasn't understood", e)
        }
    }

    /**
     * Changes how this screen shows channels. It's saved on the server, as if changed on the
     * bar's Screens page, then the feed is fetched again so the change shows straight away.
     */
    suspend fun setLayout(layout: BarLayout) = withContext(Dispatchers.IO) {
        val token = prefs.barToken ?: return@withContext
        val body = JSONObject().put("layout", layout.id).toString().toRequestBody(JSON)
        val req = Request.Builder().url("$base/api/tv/layout").header("Authorization", "Bearer $token").post(body).build()
        http.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw IOException("The bar server returned HTTP ${res.code}")
        }
        refresh()
        refreshWeather()
    }

    // ---- Linking ----

    /** Asks the server for a code to show on screen. */
    suspend fun startPairing(): Pairing = withContext(Dispatchers.IO) {
        val req = Request.Builder().url("$base/api/tv/pair").post(ByteArray(0).toRequestBody(null)).build()
        http.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw IOException("The bar server returned HTTP ${res.code}")
            val o = JSONObject(res.body!!.string())
            Pairing(o.getString("code"), o.getString("secret"), o.getLong("expiresAt"), o.optInt("pollSeconds", 3))
        }
    }

    /** Whether staff have entered [p]'s code yet. When they have, finishes linking this TV. */
    suspend fun checkPairing(p: Pairing): PairStatus = withContext(Dispatchers.IO) {
        val body = JSONObject().put("code", p.code).put("secret", p.secret).toString().toRequestBody(JSON)
        val req = Request.Builder().url("$base/api/tv/pair/status").post(body).build()
        http.newCall(req).execute().use { res ->
            if (res.code == 404 || res.code == 410) return@withContext PairStatus.Gone
            if (!res.isSuccessful) throw IOException("The bar server returned HTTP ${res.code}")
            val o = JSONObject(res.body!!.string())
            if (o.optString("status") != "linked") return@withContext PairStatus.Waiting
            val linked = PairStatus.Linked(
                o.getString("token"),
                o.getJSONObject("screen").getString("name"),
                o.getJSONObject("venue").getString("name"),
            )
            prefs.barToken = linked.token
            prefs.barScreenName = linked.screenName
            etag = null
            linked
        }
    }.also { if (it is PairStatus.Linked) start() }

    /** Unlinks this TV: tells the server, if it can, then forgets the bar. */
    fun unlink() {
        val token = prefs.barToken
        forget()
        if (token == null) return
        scope.launch {
            try {
                val req = Request.Builder().url("$base/api/tv/unlink")
                    .header("Authorization", "Bearer $token")
                    .post(ByteArray(0).toRequestBody(null)).build()
                http.newCall(req).execute().close()
            } catch (e: IOException) {
                Log.w(TAG, "Couldn't tell the bar server this TV was unlinked", e)
            }
        }
    }

    /**
     * Asks MET Norway for the weather, straight from the TV, every [WEATHER_MS] while the screen can be framed,
     * which is the only place it shows. The bar server only says where the TV is (in the feed). MET Norway asks
     * that apps say who they are, so the request names OpenGuide.
     */
    private fun refreshWeather() {
        val feed = _feed.value ?: return
        if (feed.layout == BarLayout.FULL) return
        val place = feed.weatherPlace ?: return
        val now = System.currentTimeMillis()
        if (now - weatherAt < WEATHER_MS) return
        val req = Request.Builder().url(metForecastUrl(place))
            .header("User-Agent", "OpenGuide/${BuildConfig.VERSION_NAME} (+https://github.com/zapiltar/OpenGuide)")
            .build()
        try {
            http.newCall(req).execute().use { res ->
                if (!res.isSuccessful) throw IOException("MET Norway returned HTTP ${res.code}")
                _weather.value = parseMetForecast(res.body!!.string(), now, place.us)
                weatherAt = now
            }
        } catch (e: Exception) {
            if (e !is IOException && e !is JSONException) throw e
            Log.w(TAG, "Couldn't get the weather", e)
            // Try again in a few minutes, rather than every minute.
            weatherAt = now - WEATHER_MS + WEATHER_RETRY_MS
        }
    }

    private fun forget() {
        poller?.cancel()
        poller = null
        weatherLoop?.cancel()
        weatherLoop = null
        link.stop()
        prefs.barToken = null
        prefs.barScreenName = null
        prefs.setEtag(ETAG_KEY, null)
        etag = null
        cacheFile.delete()
        _feed.value = null
        _weather.value = null
        bingo.reset()
    }

    private companion object {
        const val TAG = "BarMode"
        const val ETAG_KEY = "bar_feed"
        /** A backup in case a send was missed; changes normally arrive as they're sent. */
        const val POLL_MS = 60 * 60_000L
        const val WEATHER_MS = 30 * 60_000L
        const val WEATHER_RETRY_MS = 5 * 60_000L
        val JSON = "application/json; charset=utf-8".toMediaType()
    }
}
