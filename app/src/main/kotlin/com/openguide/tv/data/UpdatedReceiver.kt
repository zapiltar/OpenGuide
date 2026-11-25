package com.openguide.tv.data

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.openguide.tv.ui.MainActivity

/**
 * Android closes an app while it updates it, and the install screen doesn't offer to open it again, so a TV
 * would be left on its home screen. Android tells the app once it's been replaced, and this opens OpenGuide
 * again. OpenGuide is only ever updated on purpose (it isn't in an app store that updates in the background),
 * so it reopens after any update.
 */
class UpdatedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        Log.i("Update", "Updated; opening OpenGuide again")
        try {
            context.startActivity(
                Intent(context, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            )
        } catch (e: Exception) {
            // Some versions of Android don't let an app open itself from the background.
            Log.w("Update", "Couldn't open OpenGuide after the update", e)
        }
    }
}
