// SPDX-License-Identifier: GPL-3.0-or-later
package app.umbrapdf

import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.io.FileOutputStream
import java.util.concurrent.Executors

/**
 * JS <-> Kotlin bridge, exposed as window.UmbraAndroid.
 * JS calls in; results go back via window.__umbraHost.onPicked / onSaved.
 * Only file I/O lives here — all PDF processing stays in the web core.
 */
class UmbraBridge(private val activity: MainActivity, private val store: LocalFileStore) {
    private val io = Executors.newSingleThreadExecutor()
    @Volatile private var jsReady = false
    @Volatile private var pendingExternal: String? = null
    @Volatile private var pendingSaveToken: String? = null

    // ---- Called from JS (JavaBridge thread) ----

    @JavascriptInterface
    fun ready() {
        jsReady = true
        pendingExternal?.let { pendingExternal = null; post("onPicked", it) }
    }

    @JavascriptInterface
    fun pickPdf() = activity.runOnUiThread { activity.launchOpen() }

    @JavascriptInterface
    fun beginSave(): String {
        val (token, file) = store.newFile()
        file.writeBytes(ByteArray(0))
        return token
    }

    @JavascriptInterface
    fun appendChunk(token: String, base64: String): Boolean = try {
        val f = store.get(token) ?: error("unknown save token")
        FileOutputStream(f, true).use { it.write(Base64.decode(base64, Base64.DEFAULT)) }
        true
    } catch (e: Exception) {
        store.release(token)
        false
    }

    @JavascriptInterface
    fun commitSave(token: String, suggestedName: String) {
        pendingSaveToken = token
        val safe = suggestedName.replace(Regex("[\\\\/:*?\"<>|]"), "_").take(120)
        activity.runOnUiThread { activity.launchCreate(safe) }
    }

    @JavascriptInterface
    fun release(token: String) = store.release(token)

    // ---- Settings & look (small, non-sensitive; never document content) ----

    private val prefs = activity.getSharedPreferences("umbra", android.content.Context.MODE_PRIVATE)

    @JavascriptInterface
    fun getPrefs(): String = prefs.getString("prefs", "") ?: ""

    @JavascriptInterface
    fun setPrefs(json: String) {
        if (json.length <= 64_000) prefs.edit().putString("prefs", json).apply()
    }

    @JavascriptInterface
    fun systemDark(): Boolean = activity.isSystemDark()

    @JavascriptInterface
    fun setBarStyle(dark: Boolean) = activity.runOnUiThread { activity.applyBarStyle(dark) }

    @JavascriptInterface
    fun insets(): String = activity.insetsJson

    /** "Hide content in Recent apps": FLAG_SECURE blanks the app-switcher preview and blocks screenshots. */
    @JavascriptInterface
    fun setSecure(on: Boolean) = activity.runOnUiThread { activity.applySecure(on) }

    /** Saved "Hide content in Recent apps" choice, read natively so it applies before the first frame. */
    fun savedHideRecents(): Boolean = try {
        org.json.JSONObject(getPrefs().ifEmpty { "{}" }).optJSONObject("opts")?.optBoolean("hideRecents", false) ?: false
    } catch (e: Exception) { false }

    // ---- Called from MainActivity ----

    /** Copy a SAF/intent URI into the staging area and hand a same-origin URL to JS. */
    fun deliverPicked(uri: Uri?, external: Boolean) {
        if (uri == null) { post("onPicked", JSONObject().put("ok", false).toString()); return }
        io.execute {
            val msg = try {
                val (token, file) = store.newFile()
                activity.contentResolver.openInputStream(uri).use { input ->
                    requireNotNull(input) { "cannot open" }
                    file.outputStream().use { input.copyTo(it) }
                }
                JSONObject()
                    .put("ok", true)
                    .put("token", token)
                    .put("url", "https://${MainActivity.HOST}/local/$token")
                    .put("name", displayName(uri))
                    .put("external", external)
            } catch (e: Exception) {
                JSONObject().put("ok", false).put("error", e.message ?: "read failed")
            }.toString()
            if (external && !jsReady) pendingExternal = msg else post("onPicked", msg)
        }
    }

    fun finishSave(uri: Uri?) {
        val token = pendingSaveToken.also { pendingSaveToken = null }
        if (token == null) return
        if (uri == null) { store.release(token); post("onSaved", """{"ok":false}"""); return }
        io.execute {
            val ok = try {
                val f = store.get(token) ?: error("missing temp file")
                activity.contentResolver.openOutputStream(uri, "wt").use { out ->
                    requireNotNull(out) { "cannot write" }
                    f.inputStream().use { it.copyTo(out) }
                }
                true
            } catch (e: Exception) {
                false
            } finally {
                store.release(token)
            }
            post("onSaved", JSONObject().put("ok", ok).toString())
        }
    }

    fun shutdown() = io.shutdownNow()

    private fun displayName(uri: Uri): String =
        activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        } ?: "document.pdf"

    private fun post(fn: String, json: String) = callJs(fn, JSONObject.quote(json))

    /** Call window.__umbraHost.<fn>(<jsArg>) if the page has registered it. jsArg must be a JS literal. */
    fun callJs(fn: String, jsArg: String) = activity.runOnUiThread {
        activity.evalJs("window.__umbraHost && window.__umbraHost.$fn && window.__umbraHost.$fn($jsArg)")
    }
}
