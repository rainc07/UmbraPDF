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
import org.json.JSONObject
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import java.io.ByteArrayInputStream

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

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
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
        bridge.shutdown()
        store.clear()
        web.destroy()
        super.onDestroy()
    }

    private fun blocked() = WebResourceResponse(
        "text/plain", "utf-8", 403, "Blocked by Umbra (offline)", emptyMap(), ByteArrayInputStream(ByteArray(0)),
    )
}
