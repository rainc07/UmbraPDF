// SPDX-License-Identifier: GPL-3.0-or-later
package app.umbrapdf

import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.view.WindowManager
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.min

/**
 * Thin shell: one WebView hosting the bundled web core. No network, no file:// access.
 * Every request the WebView makes is answered locally or refused.
 */
class MainActivity : ComponentActivity() {
    companion object {
        const val HOST = "appassets.androidplatform.net"
        private const val START_URL = "https://$HOST/assets/web/index.html"
    }

    private lateinit var web: WebView
    private lateinit var store: LocalFileStore
    private lateinit var bridge: UmbraBridge

    private val openDoc = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        bridge.deliverPicked(uri, external = false)
    }
    private val createDoc = registerForActivityResult(ActivityResultContracts.CreateDocument("application/pdf")) { uri ->
        bridge.finishSave(uri)
    }

    private val askNotify = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    fun launchOpen() = openDoc.launch(arrayOf("application/pdf"))
    fun launchCreate(name: String) = createDoc.launch(name)
    fun evalJs(js: String) = web.evaluateJavascript(js, null)

    /** Latest safe-area insets in CSS px, handed to the web UI (it draws under the system bars). */
    @Volatile var insetsJson: String = "{\"top\":0,\"bottom\":0,\"left\":0,\"right\":0}"
        private set

    fun isSystemDark(): Boolean =
        (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    /**
     * "Hide content in Recent apps": FLAG_SECURE blanks the app-switcher preview and blocks screenshots and
     * screen recording. Android 13+ also gets an explicit "no Recents screenshot".
     */
    fun applySecure(on: Boolean) {
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(!on)
    }

    /** Status/navigation bar icon colours follow the theme the web UI is showing. */
    fun applyBarStyle(dark: Boolean) {
        val c = WindowCompat.getInsetsController(window, window.decorView)
        c.isAppearanceLightStatusBars = !dark
        c.isAppearanceLightNavigationBars = !dark
    }

    // ---- Native OCR (PaddleOCR on ONNX Runtime), reached from JS as window.UmbraOcr (WebMessageListener) ----
    private lateinit var ocr: PpOcr
    private val ocrExec = Executors.newSingleThreadExecutor()
    @Volatile var nativeOcr = false
        private set
    @Volatile var nativeOcrBinary = false
        private set

    private fun installOcr() = try { installOcrUnsafe() } catch (e: Throwable) {
        android.util.Log.e("umbra", "native OCR unavailable", e) // the web core falls back to Tesseract
        nativeOcr = false
    }

    private fun installOcrUnsafe() {
        val assets = applicationContext.assets
        ocr = PpOcr { n -> assets.open("web/vendor/ppocr/$n").use { it.readBytes() } }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        nativeOcrBinary = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)
        scan = NativeScan(ocr, ocrExec, scanEvents)
        WebViewCompat.addWebMessageListener(web, "UmbraOcr", setOf("https://$HOST")) { _, message, _, isMainFrame, reply ->
            if (!isMainFrame) return@addWebMessageListener
            val bin = if (nativeOcrBinary && message.type == WebMessageCompat.TYPE_ARRAY_BUFFER) message.arrayBuffer else null
            val str = if (message.type == WebMessageCompat.TYPE_STRING) message.data else null
            ocrExec.execute {
                val json = ocrRequest(bin, str)
                runOnUiThread { reply.postMessage(json) }
            }
        }
        nativeOcr = true
    }

    /**
     * Binary request: little-endian int32 header [id, width, height, detLimit] + RGBA pixels.
     * String request: {"id", "kind":"warm"} to load the models, or {"id","w","h","limit","b64"} (no ArrayBuffer support).
     */
    private fun ocrRequest(bin: ByteArray?, str: String?): String {
        var id = 0
        return try {
            if (bin != null) {
                val h = ByteBuffer.wrap(bin, 0, 16).order(ByteOrder.LITTLE_ENDIAN)
                id = h.int
                val w = h.int; val hh = h.int; val limit = h.int
                require(bin.size >= 16 + w * hh * 4) { "short image" }
                ocr.run(id, w, hh, limit, bin, 16)
            } else {
                val j = JSONObject(str ?: "{}")
                id = j.optInt("id")
                if (j.optString("kind") == "warm") {
                    val ms = ocr.ensureLoaded()
                    JSONObject().put("id", id).put("ok", true).put("load", ms).put("threads", ocr.threads).toString()
                } else {
                    val px = android.util.Base64.decode(j.getString("b64"), android.util.Base64.DEFAULT)
                    ocr.run(id, j.getInt("w"), j.getInt("h"), j.getInt("limit"), px, 0)
                }
            }
        } catch (e: Throwable) {
            JSONObject().put("id", id).put("ok", false).put("error", e.toString()).toString()
        }
    }

    // ---- Native scan of scanned pages (keeps going in the background; see NativeScan) ----
    private var scan: NativeScan? = null
    private var scanning = false
    private var scanPages = 0 // pages in the document (the notification counts like the page: "Reading page 5 of 23")

    private val scanEvents = object : NativeScan.Events {
        override fun onPage(index: Int, done: Int, total: Int) = runOnUiThread {
            bridge.callJs("onScanPage", index.toString())
            // Page index+1 is read; the next one is being read now (what the app shows too).
            val n = max(scanPages, index + 1)
            if (scanning) WorkService.progress(this@MainActivity, if (jsWork) workTitle else getString(R.string.scan_title),
                getString(R.string.scan_progress, min(index + 2, n), n), done * 100 / max(1, total))
        }
        override fun onFinished(cancelled: Boolean) = runOnUiThread {
            if (!scanning) return@runOnUiThread
            scanning = false
            if (!jsWork) { WorkService.stop(this@MainActivity); return@runOnUiThread }
            if (cancelled) return@runOnUiThread
            // The page's scan finishes within moments and reports itself, unless Android froze the page in the
            // background: then it finishes once the app is shown again, so say now that it's ready.
            web.postDelayed({
                if (jsWork && !scanning && !visible) {
                    jsWork = false
                    WorkService.stop(this@MainActivity)
                    WorkService.done(this@MainActivity, getString(R.string.scan_done_title), getString(R.string.scan_done_text))
                }
            }, 5000)
        }
    }

    /** pagesJson: [{i, w, h, pw, ph}] (page index, bitmap px, page size in points). False: the page reads them itself. */
    fun scanStart(token: String, pagesJson: String): Boolean {
        val s = scan ?: return false
        val f = store.get(token) ?: return false
        val a = JSONArray(pagesJson)
        val pages = (0 until a.length()).map { k ->
            val o = a.getJSONObject(k)
            NativeScan.Page(o.getInt("i"), o.getInt("w"), o.getInt("h"), o.getDouble("pw").toFloat(), o.getDouble("ph").toFloat())
        }
        if (a.length() > 0) scanPages = a.getJSONObject(0).optInt("n", 0)
        s.start(f, pages)
        if (s.running) runOnUiThread {
            // Our own flags, not WorkService.running: a stop just requested may not have reached the service yet.
            if (!scanning) { scanning = true; if (!jsWork) WorkService.start(this, getString(R.string.scan_title)) }
        }
        return true
    }

    fun scanTake(index: Int): String = scan?.take(index) ?: ""
    fun scanCancel() { scan?.cancel() }
    fun scanReset() { scan?.reset(); runOnUiThread { if (scanning) { scanning = false; if (!jsWork) WorkService.stop(this) } } }

    // ---- Background work + notifications ----
    @Volatile var visible = false
        private set
    private var workTitle = ""
    private var jsWork = false

    /** Asked once, at first launch (API 33+): background work and "ready" notifications need it. */
    private fun askNotificationPermissionOnce() {
        val p = getSharedPreferences("umbra", MODE_PRIVATE)
        if (Build.VERSION.SDK_INT >= 33 && !p.getBoolean("askedNotify", false) &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            p.edit().putBoolean("askedNotify", true).apply()
            askNotify.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    fun workStart(title: String) {
        workTitle = title
        jsWork = true
        WorkService.clearDone(this)
        if (scanning) WorkService.progress(this, title, "", -1) else WorkService.start(this, title)
    }

    // While pages are read natively, the notification counts those (the page's own count would jump back and forth).
    fun workProgress(text: String, pct: Int) { if (jsWork && !scanning) WorkService.progress(this, workTitle, text, pct) }

    fun workDone(title: String, text: String) {
        val was = jsWork
        jsWork = false
        if (!scanning) WorkService.stop(this)
        if (was && !visible) WorkService.done(this, title, text)
    }

    override fun onResume() { super.onResume(); visible = true; WorkService.clearDone(this) }
    override fun onPause() { visible = false; super.onPause() }

    /** Last crash's stack trace (shown once in the app so it can be copied and reported), then cleared. */
    fun takeLastCrash(): String {
        val f = java.io.File(filesDir, "last-crash.txt")
        return if (f.exists()) f.readText().also { f.delete() } else ""
    }

    private fun recordCrashes() {
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            try {
                val sw = java.io.StringWriter()
                e.printStackTrace(java.io.PrintWriter(sw))
                java.io.File(filesDir, "last-crash.txt").writeText(
                    "Umbra PDF ${packageManager.getPackageInfo(packageName, 0).versionName} · Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}) · ${Build.MANUFACTURER} ${Build.MODEL}\nThread: ${t.name}\n$sw".take(20_000),
                )
            } catch (_: Throwable) { }
            prev?.uncaughtException(t, e)
        }
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        recordCrashes()
        super.onCreate(savedInstanceState)
        // Transparent system bars; the web UI paints behind them and pads itself with the insets.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
        )
        if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
        applyBarStyle(isSystemDark())

        store = LocalFileStore(cacheDir)
        bridge = UmbraBridge(this, store)
        applySecure(bridge.savedHideRecents()) // before any content is drawn

        val loader = WebViewAssetLoader.Builder()
            .setDomain(HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/local/", store.pathHandler)
            .build()

        WebView.setWebContentsDebuggingEnabled((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0)

        web = WebView(this).apply {
            settings.apply {
                javaScriptEnabled = true
                allowFileAccess = false
                allowContentAccess = false
                domStorageEnabled = false
                databaseEnabled = false
                setGeolocationEnabled(false)
                javaScriptCanOpenWindowsAutomatically = false
                setSupportMultipleWindows(false)
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                cacheMode = WebSettings.LOAD_NO_CACHE
                builtInZoomControls = false
                if (Build.VERSION.SDK_INT >= 26) safeBrowsingEnabled = false
            }
            // Matches the splash background so there is no white flash before the page paints.
            setBackgroundColor(0xFF111214.toInt()) // = splash colour (always dark), so nothing flashes before the page paints
            webViewClient = object : WebViewClientCompat() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse =
                    loader.shouldInterceptRequest(request.url) ?: blocked()

                // No navigation away from the app page, ever.
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
            }
            addJavascriptInterface(bridge, "UmbraAndroid")
        }
        // Keep the page's renderer at full priority while the app is in the background (scans keep going).
        try {
            if (Build.VERSION.SDK_INT >= 26) web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
            WorkService.channels(this)
        } catch (e: Throwable) { android.util.Log.e("umbra", "background work setup failed", e) }
        installOcr()
        askNotificationPermissionOnce()
        // WebView ignores its own padding, so insets go on a container around it.
        val root = FrameLayout(this).apply { addView(web) }
        setContentView(root)

        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            // Only the keyboard shrinks the WebView; status/nav bars are handled by the page (no black bars).
            v.setPadding(0, 0, 0, ime.bottom)
            val d = resources.displayMetrics.density
            insetsJson = JSONObject()
                .put("top", (bars.top / d).toDouble())
                .put("bottom", if (ime.bottom > 0) 0.0 else (bars.bottom / d).toDouble())
                .put("left", (bars.left / d).toDouble())
                .put("right", (bars.right / d).toDouble())
                .toString()
            bridge.callJs("onInsets", JSONObject.quote(insetsJson))
            WindowInsetsCompat.CONSUMED
        }

        // Back goes to the page first (close dialog/panel, leave document with confirm); the OS only gets it on the start screen.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("(window.__umbraHost && window.__umbraHost.onBack) ? window.__umbraHost.onBack() : false") { r ->
                    if (r != "true") {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            }
        })

        web.loadUrl(START_URL)
        handleIntent(intent)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // uiMode is in configChanges (no recreate, document stays open), so push dark/light to the page.
        bridge.callJs("onSystemTheme", isSystemDark().toString())
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        if (intent?.action == Intent.ACTION_VIEW) intent.data?.let { bridge.deliverPicked(it, external = true) }
    }

    override fun onDestroy() {
        scan?.reset()
        scan?.shutdown()
        WorkService.stop(this)
        ocrExec.shutdownNow()
        bridge.shutdown()
        store.clear()
        web.destroy()
        super.onDestroy()
    }

    private fun blocked() = WebResourceResponse(
        "text/plain", "utf-8", 403, "Blocked by Umbra (offline)", emptyMap(), ByteArrayInputStream(ByteArray(0)),
    )
}
