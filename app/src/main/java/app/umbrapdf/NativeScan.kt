// SPDX-License-Identifier: GPL-3.0-or-later
package app.umbrapdf

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Reads scanned pages natively, outside the WebView, so a scan keeps going while the app is in the background
 * (Android freezes a hidden page's scripts). For each page: PdfRenderer renders it at the size the web core
 * asked for, its blocks of print are found (same rule as inkIslands in ppocr.ts) and each block is read with
 * PpOcr. Results stay here, in page pixels, until the web core takes them (it then finds ID cards and builds
 * the page text itself). Each page is its own task on the OCR thread, so the page's own OCR requests interleave.
 */
class NativeScan(private val ocr: PpOcr, private val exec: ExecutorService, private val events: Events) {
    interface Events {
        fun onPage(index: Int, done: Int, total: Int)
        fun onFinished(cancelled: Boolean)
    }

    /** Page to read: bitmap size (px) and the page size in points the web core expects (geometry check). */
    class Page(val index: Int, val w: Int, val h: Int, val pw: Float, val ph: Float)

    private class Job(val id: Int, val file: File, val pages: List<Page>) {
        var pfd: ParcelFileDescriptor? = null
        var renderer: PdfRenderer? = null
        var done = 0
        fun close() {
            try { renderer?.close() } catch (_: Throwable) { }
            try { pfd?.close() } catch (_: Throwable) { }
            renderer = null; pfd = null
        }
    }

    private val results = ConcurrentHashMap<Int, String>()
    @Volatile private var gen = 0
    @Volatile var running = false
        private set

    /** Start reading pages of `file` (pages already read are skipped). Replaces any running job. */
    fun start(file: File, pages: List<Page>): Boolean {
        cancel(notify = false)
        val todo = pages.filter { !results.containsKey(it.index) }
        if (todo.isEmpty()) return true
        val job = Job(++gen, file, todo)
        running = true
        for (p in todo) exec.execute { if (job.id == gen) readPage(job, p) }
        exec.execute {
            job.close()
            if (job.id == gen) { running = false; events.onFinished(false) }
        }
        return true
    }

    /** Stop after the page being read. Pages already read stay available. */
    fun cancel(notify: Boolean = true) {
        gen++
        if (running) { running = false; if (notify) events.onFinished(true) }
    }

    /** Forget everything (another document was opened, or it was closed). */
    fun reset() { cancel(notify = false); results.clear() }

    /** A page's result JSON, or "" if it hasn't been read (yet). */
    fun take(index: Int): String = results[index] ?: ""

    private fun readPage(job: Job, p: Page) {
        val t0 = System.nanoTime()
        val out = try {
            val r = job.renderer ?: run {
                val fd = ParcelFileDescriptor.open(job.file, ParcelFileDescriptor.MODE_READ_ONLY)
                job.pfd = fd
                PdfRenderer(fd).also { job.renderer = it }
            }
            val pg = r.openPage(p.index)
            val bm: Bitmap
            try {
                // pdf.js and PdfRenderer must agree on the page box (crop box, /Rotate), or the boxes would be misplaced.
                if (abs(pg.width - p.pw) > 2f || abs(pg.height - p.ph) > 2f) error("page size ${pg.width}x${pg.height} != ${p.pw}x${p.ph}")
                bm = Bitmap.createBitmap(p.w, p.h, Bitmap.Config.ARGB_8888)
                bm.eraseColor(Color.WHITE)
                pg.render(bm, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            } finally { pg.close() }
            val t1 = System.nanoTime()
            val px = ByteArray(p.w * p.h * 4)
            bm.copyPixelsToBuffer(ByteBuffer.wrap(px)) // ARGB_8888 is stored as R, G, B, A bytes
            val islands = inkIslands(bm)
            bm.recycle()
            val blocks = JSONArray()
            var det = 0L; var rec = 0L; var retry = 0L
            for (b in islands) {
                if (job.id != gen) break
                val crop = ByteArray(b.w * b.h * 4)
                for (y in 0 until b.h) System.arraycopy(px, ((b.y0 + y) * p.w + b.x0) * 4, crop, y * b.w * 4, b.w * 4)
                val res = JSONObject(ocr.run(0, b.w, b.h, min(PAGE_LIMIT, max(b.w, b.h)), crop, 0))
                if (!res.optBoolean("ok")) error(res.optString("error", "OCR failed"))
                res.optJSONObject("ms")?.let { det += it.optLong("det"); rec += it.optLong("rec"); retry += it.optLong("retry") }
                val lines = res.getJSONArray("lines")
                for (i in 0 until lines.length()) {
                    val q = lines.getJSONObject(i).getJSONArray("quad")
                    for (k in 0 until q.length()) {
                        val pt = q.getJSONArray(k)
                        pt.put(0, pt.getDouble(0) + b.x0); pt.put(1, pt.getDouble(1) + b.y0)
                    }
                }
                blocks.put(lines)
            }
            if (job.id != gen) return
            val ms = { a: Long, z: Long -> (z - a) / 1_000_000 }
            JSONObject().put("ok", true).put("blocks", blocks).put("ms", JSONObject()
                .put("render", ms(t0, t1)).put("total", ms(t0, System.nanoTime())).put("islands", islands.size)
                .put("det", det).put("rec", rec).put("retry", retry).put("threads", ocr.threads)).toString()
        } catch (e: Throwable) {
            if (job.id != gen) return
            JSONObject().put("ok", false).put("error", e.toString()).toString()
        }
        results[p.index] = out
        job.done++
        events.onPage(p.index, job.done, job.pages.size)
    }

    private class Box(val x0: Int, val y0: Int, val w: Int, val h: Int)

    /** Blocks of print (upright boxes with a margin) on a mostly blank page, merged when close; specks skipped. */
    private fun inkIslands(c: Bitmap): List<Box> {
        val s = min(1f, 600f / max(c.width, c.height))
        val w = max(1, (c.width * s).roundToInt()); val h = max(1, (c.height * s).roundToInt())
        val sm = Bitmap.createScaledBitmap(c, w, h, true)
        val d = IntArray(w * h)
        sm.getPixels(d, 0, w, 0, 0, w, h)
        if (sm !== c) sm.recycle()
        val r = 6 // join print within ~1% of the page
        val ink = BooleanArray(w * h) { val v = d[it]; min(min((v shr 16) and 0xFF, (v shr 8) and 0xFF), v and 0xFF) < 170 }
        // Dilate by r (separable max) so letters and words of one block connect.
        val tmp = BooleanArray(w * h); val grown = BooleanArray(w * h)
        for (y in 0 until h) for (x in 0 until w) {
            var v = false; var k = max(0, x - r); val e = min(w - 1, x + r)
            while (k <= e && !v) { v = ink[y * w + k]; k++ }
            tmp[y * w + x] = v
        }
        for (y in 0 until h) for (x in 0 until w) {
            var v = false; var k = max(0, y - r); val e = min(h - 1, y + r)
            while (k <= e && !v) { v = tmp[k * w + x]; k++ }
            grown[y * w + x] = v
        }
        val seen = BooleanArray(w * h)
        val out = ArrayList<Box>()
        val stack = IntArray(w * h)
        for (s0 in 0 until w * h) {
            if (!grown[s0] || seen[s0]) continue
            var x0 = w; var y0 = h; var x1 = 0; var y1 = 0; var cnt = 0; var sp = 0
            seen[s0] = true; stack[sp++] = s0
            while (sp > 0) {
                val i = stack[--sp]; val x = i % w; val y = i / w
                if (ink[i]) cnt++
                if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
                if (x > 0 && grown[i - 1] && !seen[i - 1]) { seen[i - 1] = true; stack[sp++] = i - 1 }
                if (x < w - 1 && grown[i + 1] && !seen[i + 1]) { seen[i + 1] = true; stack[sp++] = i + 1 }
                if (y > 0 && grown[i - w] && !seen[i - w]) { seen[i - w] = true; stack[sp++] = i - w }
                if (y < h - 1 && grown[i + w] && !seen[i + w]) { seen[i + w] = true; stack[sp++] = i + w }
            }
            if (cnt < 6) continue // specks
            val bx0 = max(0f, x0 / s); val by0 = max(0f, y0 / s)
            val bx1 = min(c.width.toFloat(), (x1 + 1) / s); val by1 = min(c.height.toFloat(), (y1 + 1) / s)
            val ix0 = floor(bx0).toInt(); val iy0 = floor(by0).toInt()
            out.add(Box(ix0, iy0, min(c.width - ix0, ceil(bx1 - bx0).toInt()), min(c.height - iy0, ceil(by1 - by0).toInt())))
        }
        return out
    }

    companion object { private const val PAGE_LIMIT = 1600 }
}
