package com.openguide.tv.data

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import java.io.File

/**
 * Installs a downloaded update through Android's PackageInstaller. Opening the APK with ACTION_VIEW, as
 * OpenGuide used to, sometimes did nothing at all on the first try on TVs; a session always reports back, so
 * either the system's "Install?" screen appears or [onResult] says why it didn't.
 *
 * [register] in onCreate and [unregister] in onDestroy: the result arrives as a broadcast while the system's
 * screen is in front.
 */
class UpdateInstaller(private val activity: Activity, private val onResult: (error: String?) -> Unit) {
    private val action = "${activity.packageName}.UPDATE_STATUS"

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
            val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
            Log.i(TAG, "Install status $status: $message")
            when (status) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                    @Suppress("DEPRECATION")
                    val confirm = (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                    else intent.getParcelableExtra(Intent.EXTRA_INTENT)) as Intent?
                    if (confirm == null) {
                        onResult("Android didn't show the install screen. Try again")
                        return
                    }
                    try {
                        activity.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    } catch (e: Exception) {
                        Log.w(TAG, "Couldn't show the install screen", e)
                        onResult("Android didn't show the install screen. Try again")
                    }
                }
                PackageInstaller.STATUS_SUCCESS -> onResult(null)
                PackageInstaller.STATUS_FAILURE_ABORTED -> onResult("The update wasn't installed. Press to try again")
                PackageInstaller.STATUS_FAILURE_STORAGE -> onResult("Not enough space to install the update")
                PackageInstaller.STATUS_FAILURE_INCOMPATIBLE, PackageInstaller.STATUS_FAILURE_CONFLICT ->
                    onResult("This update can't replace the installed app. Uninstall OpenGuide, then install it again")
                else -> onResult("The update didn't install${message?.let { ": $it" } ?: ""}. Press to try again")
            }
        }
    }

    fun register() {
        ContextCompat.registerReceiver(activity, receiver, IntentFilter(action), ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    fun unregister() {
        try {
            activity.unregisterReceiver(receiver)
        } catch (_: IllegalArgumentException) {
        }
    }

    /** Copies [apk] into an install session and commits it. Slow, so call it off the main thread. */
    fun install(apk: File) {
        val installer = activity.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(activity.packageName)
            setSize(apk.length())
        }
        val id = installer.createSession(params)
        try {
            installer.openSession(id).use { session ->
                session.openWrite("OpenGuide.apk", 0, apk.length()).use { out ->
                    apk.inputStream().use { it.copyTo(out, 1 shl 16) }
                    session.fsync(out)
                }
                // The system fills in the result, so the intent has to be mutable (and so, explicit) from Android 12.
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                val result = PendingIntent.getBroadcast(activity, id, Intent(action).setPackage(activity.packageName), flags)
                session.commit(result.intentSender)
            }
        } catch (e: Exception) {
            installer.abandonSession(id)
            throw e
        }
    }

    private companion object {
        const val TAG = "Update"
    }
}
