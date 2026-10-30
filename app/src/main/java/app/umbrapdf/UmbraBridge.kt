// SPDX-License-Identifier: GPL-3.0-or-later
package app.umbrapdf

import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.io.FileOutputStream
import java.util.concurrent.Executors

/**
 * JS <-> Kotlin bridge, exposed as window.UmbraAndroid.
 * JS calls in; results go back via window.__umbraHost.onPicked / onSaved.
 * File I/O, settings and background work live here; PDF processing stays in the web core (the native scan
 * only reads pages' pixels for it).
 */
class UmbraBridge(private val activity: MainActivity, private val store: LocalFileStore) {
    private val io = Executors.newSingleThreadExecutor()
    @Volatile private var jsReady = false
    @Volatile private var pendingExternal: String? = null
    @Volatile private var pendingSaveToken: String? = null
    @Volatile private var pendingSaveAll: List<Pair<String, String>>? = null

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
        activity.runOnUiThread { activity.launchCreate(safeName(suggestedName)) }
    }

    /** A split: several staged files, saved into one folder the user picks. */
    @JavascriptInterface
    fun commitSaveAll(tokensJson: String, namesJson: String) {
        val tokens = JSONArray(tokensJson)
        val names = JSONArray(namesJson)
        pendingSaveAll?.forEach { store.release(it.first) }
        pendingSaveAll = (0 until tokens.length()).map { i -> tokens.getString(i) to safeName(names.optString(i, "part-${i + 1}.pdf")) }
        activity.runOnUiThread { activity.launchPickFolder() }
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

    /** Saved "Hide content in Recent apps" choice (on unless turned off), read natively so it applies before the first frame. */
    fun savedHideRecents(): Boolean = try {
        org.json.JSONObject(getPrefs().ifEmpty { "{}" }).optJSONObject("opts")?.optBoolean("hideRecents", true) ?: true
    } catch (e: Exception) { true }

    /** Stack trace of the last crash, if any (shown once so the user can copy it into a bug report). */
    @JavascriptInterface
    fun lastCrash(): String = try { activity.takeLastCrash() } catch (e: Exception) { "" }

    // ---- Native OCR and background work ----

    /** {"native":bool,"binary":bool}: whether window.UmbraOcr (native PaddleOCR) is available, and takes ArrayBuffers. */
    @JavascriptInterface
    fun ocrCaps(): String = JSONObject().put("native", activity.nativeOcr).put("binary", activity.nativeOcrBinary).toString()

    /** OCR text language from Settings: "en" (English) or "ch" (Chinese, Simplified + Traditional). Used from the next read. */
    @JavascriptInterface
    fun setOcrLang(lang: String) = activity.setOcrLang(lang)

    /** Long work started (scan or export): keeps running with an ongoing notification if the user leaves the app. */
    @JavascriptInterface
    fun workStart(title: String) = activity.runOnUiThread { activity.workStart(title.take(80)) }

    @JavascriptInterface
    fun workProgress(text: String, pct: Int) = activity.runOnUiThread { activity.workProgress(text.take(120), pct) }

    /** Work finished: a notification is shown only if the app isn't on screen. Text must not contain document content. */
    @JavascriptInterface
    fun workDone(title: String, text: String) = activity.runOnUiThread { activity.workDone(title.take(80), text.take(160)) }

    /** Read scanned pages natively (keeps going in the background). token: the open document's staged file. */
    @JavascriptInterface
    fun scanStart(token: String, pagesJson: String): Boolean = try { activity.scanStart(token, pagesJson) } catch (e: Exception) { false }

    /** A page's native read (JSON), or "" if not read (yet). */
    @JavascriptInterface
    fun scanTake(index: Int): String = activity.scanTake(index)

    @JavascriptInterface
    fun scanCancel() = activity.scanCancel()

    /** Forget the document's pages (closed, or another one opened). */
    @JavascriptInterface
    fun scanReset() = activity.scanReset()

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

    fun finishSaveAll(tree: Uri?) {
        val files = pendingSaveAll.also { pendingSaveAll = null } ?: return
        if (tree == null) { files.forEach { store.release(it.first) }; post("onSavedAll", """{"ok":false,"count":0}"""); return }
        io.execute {
            var count = 0
            val ok = try {
                val dir = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
                for ((token, name) in files) {
                    // The provider picks a free name if one is taken ("name (1).pdf"), so nothing is overwritten.
                    val uri = requireNotNull(DocumentsContract.createDocument(activity.contentResolver, dir, "application/pdf", name)) { "cannot create" }
                    val f = store.get(token) ?: error("missing temp file")
                    activity.contentResolver.openOutputStream(uri, "wt").use { out ->
                        requireNotNull(out) { "cannot write" }
                        f.inputStream().use { it.copyTo(out) }
                    }
                    store.release(token)
                    count++
                }
                true
            } catch (e: Exception) {
                false
            } finally {
                files.forEach { store.release(it.first) }
            }
            post("onSavedAll", JSONObject().put("ok", ok).put("count", count).toString())
        }
    }

    private fun safeName(name: String) = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").take(120)

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
