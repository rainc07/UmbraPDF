// SPDX-License-Identifier: GPL-3.0-or-later
package app.umbrapdf

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Keeps the app running while it scans or prepares a file in the background (the user switched apps),
 * with an ongoing "working" notification. When the work finishes, a normal notification says it's ready.
 * Notifications never contain document content: only generic text such as "12 items found".
 */
class WorkService : Service() {
    companion object {
        private const val CH_WORK = "work"
        private const val CH_DONE = "done"
        private const val ID_WORK = 1
        private const val ID_DONE = 2
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_TEXT = "text"
        private const val EXTRA_PCT = "pct"

        /** Whether the service is in the foreground now (progress updates go to its notification only then). */
        @Volatile var running = false
            private set

        fun channels(ctx: Context) {
            if (Build.VERSION.SDK_INT < 26) return
            val nm = ctx.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CH_WORK, ctx.getString(R.string.ch_work), NotificationManager.IMPORTANCE_LOW))
            nm.createNotificationChannel(NotificationChannel(CH_DONE, ctx.getString(R.string.ch_done), NotificationManager.IMPORTANCE_DEFAULT))
        }

        private fun openApp(ctx: Context): PendingIntent = PendingIntent.getActivity(
            ctx, 0, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        fun working(ctx: Context, title: String, text: String, pct: Int): Notification =
            NotificationCompat.Builder(ctx, CH_WORK)
                .setSmallIcon(R.drawable.ic_stat_umbra)
                .setContentTitle(title)
                .setContentText(text)
                .setProgress(100, pct.coerceIn(0, 100), pct < 0)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setContentIntent(openApp(ctx))
                .build()

        fun start(ctx: Context, title: String) {
            val i = Intent(ctx, WorkService::class.java).putExtra(EXTRA_TITLE, title).putExtra(EXTRA_TEXT, "").putExtra(EXTRA_PCT, -1)
            try { androidx.core.content.ContextCompat.startForegroundService(ctx, i) } catch (e: Exception) { /* not allowed now: work continues in the app */ }
        }

        fun progress(ctx: Context, title: String, text: String, pct: Int) {
            if (!running || !NotificationManagerCompat.from(ctx).areNotificationsEnabled()) return
            try { NotificationManagerCompat.from(ctx).notify(ID_WORK, working(ctx, title, text, pct)) } catch (e: SecurityException) { }
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, WorkService::class.java))
            NotificationManagerCompat.from(ctx).cancel(ID_WORK) // a progress update may have re-posted it
        }

        /** "Ready" notification; only shown when the user isn't looking at the app. */
        fun done(ctx: Context, title: String, text: String) {
            val n = NotificationCompat.Builder(ctx, CH_DONE)
                .setSmallIcon(R.drawable.ic_stat_umbra)
                .setContentTitle(title)
                .setContentText(text)
                .setAutoCancel(true)
                .setContentIntent(openApp(ctx))
                .build()
            try { NotificationManagerCompat.from(ctx).notify(ID_DONE, n) } catch (e: SecurityException) { }
        }

        fun clearDone(ctx: Context) = NotificationManagerCompat.from(ctx).cancel(ID_DONE)
    }

    // Keeps the CPU running while the screen is off (else the phone may sleep mid-page and pause the reading).
    private var wake: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val n = working(this, intent?.getStringExtra(EXTRA_TITLE) ?: getString(R.string.app_name), intent?.getStringExtra(EXTRA_TEXT) ?: "", intent?.getIntExtra(EXTRA_PCT, -1) ?: -1)
        val type = when {
            Build.VERSION.SDK_INT >= 35 -> ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING
            Build.VERSION.SDK_INT >= 29 -> ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            else -> 0
        }
        // Straight to the framework: ServiceCompat (core 1.13) drops types it doesn't know (mediaProcessing, API 35),
        // and a foreground service with no type is refused from API 34 on.
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(ID_WORK, n, type) else startForeground(ID_WORK, n)
            running = true
            if (wake == null) wake = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "umbra:work").apply { acquire(60 * 60 * 1000L) }
        } catch (e: Exception) { android.util.Log.e("umbra", "background work can't start", e); stopSelf() }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = false
        wake?.let { if (it.isHeld) it.release() }; wake = null
        super.onDestroy()
    }

    /** Swiped away from Recents: nothing to resume, stop. */
    override fun onTimeout(startId: Int, fgsType: Int) { stopSelf() }
}
