// SPDX-License-Identifier: GPL-3.0-or-later
package app.umbrapdf

import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.File
import java.io.FileInputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Short-lived app-private staging area for documents in transit between
 * the Storage Access Framework and the WebView. Files live in cacheDir/umbra,
 * are served same-origin under /local/<token>, and are wiped on release/startup/exit.
 */
class LocalFileStore(cacheRoot: File) {
    private val dir = File(cacheRoot, "umbra").apply { deleteRecursively(); mkdirs() }
    private val files = ConcurrentHashMap<String, File>()

    fun newFile(): Pair<String, File> {
        val token = UUID.randomUUID().toString()
        val f = File(dir, token)
        files[token] = f
        return token to f
    }

    fun get(token: String): File? = files[token]

    fun release(token: String) {
        files.remove(token)?.delete()
    }

    fun clear() {
        files.clear()
        dir.deleteRecursively()
        dir.mkdirs()
    }

    /** Serves staged files to the WebView at https://appassets.androidplatform.net/local/<token>. */
    val pathHandler = WebViewAssetLoader.PathHandler { path ->
        val f = files[path.trimStart('/')] ?: return@PathHandler null
        WebResourceResponse("application/pdf", null, FileInputStream(f)).apply {
            responseHeaders = mapOf("Cache-Control" to "no-store")
        }
    }
}
