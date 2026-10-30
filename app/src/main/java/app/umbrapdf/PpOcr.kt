// SPDX-License-Identifier: GPL-3.0-or-later
package app.umbrapdf

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.nio.FloatBuffer
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * Native PaddleOCR (PP-OCRv5 mobile, Apache-2.0) on ONNX Runtime for Android (MIT), using all CPU cores.
 * Same models and the same steps as the web engine (core/src/engine/ppocr.worker.ts), which this mirrors:
 * DB text detection -> one strip per line (height 48) -> CTC recognition with character positions.
 * Input: RGBA pixels; output: JSON lines with corners in reading order (pixels), text, confidence, char spans.
 * `load` returns a model file's bytes by name (det.onnx, rec_en.onnx, dict_en.txt; rec_ch.onnx, dict_ch.txt).
 */
class PpOcr(private val load: (String) -> ByteArray) {
    // Created on first use (on the OCR thread), so a problem loading the native runtime can't stop the app from opening.
    private val env: OrtEnvironment by lazy { OrtEnvironment.getEnvironment() }
    private var det: OrtSession? = null
    private var rec: OrtSession? = null
    private var chars: List<String> = emptyList()
    /** Recognition model: "en" (English) or "ch" (Simplified + Traditional Chinese, and English). Applies from the next read. */
    @Volatile var lang = "en"
        set(v) { field = if (v == "ch") "ch" else "en" }
    private var recLang: String? = null
    /** Threads for one detection run, and recognition runs side by side: the fast cores (big.LITTLE phones), at most 4 / 6. */
    private val fast = fastCores()
    val threads = max(1, min(4, fast))
    val recThreads = max(1, min(6, fast))

    @Synchronized
    fun ensureLoaded(): Long {
        val l = lang
        if (det != null && recLang == l) return 0
        val t0 = System.nanoTime()
        fun asset(n: String) = load(n)
        if (det == null) {
            // Detection: one big image, so its operators are split over the cores. No spinning once it's done, so
            // its threads don't hold cores while the lines are read.
            val detOpts = OrtSession.SessionOptions().apply {
                setIntraOpNumThreads(threads)
                addConfigEntry("session.intra_op.allow_spinning", "0")
                setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
            }
            det = env.createSession(asset("det.onnx"), detOpts)
        }
        // Recognition: many small strips, so each batch runs on one core and the batches run side by side
        // (splitting one small strip's operators over 4 cores mostly waits on the other cores).
        val recOpts = OrtSession.SessionOptions().apply {
            setIntraOpNumThreads(1)
            // Not ALL_OPT: its blocked memory layout (x86) spent a fifth of the time converting between layouts here.
            setOptimizationLevel(OrtSession.SessionOptions.OptLevel.EXTENDED_OPT)
        }
        // Only one recognition model is kept loaded (the Chinese one is about 16 MB).
        rec?.close(); rec = null; recLang = null
        rec = env.createSession(asset("rec_$l.onnx"), recOpts)
        val lines = String(asset("dict_$l.txt"), Charsets.UTF_8).split("\n").map { it.trimEnd('\r') }.toMutableList()
        if (lines.isNotEmpty() && lines.last().isEmpty()) lines.removeAt(lines.size - 1)
        chars = lines + " "
        recLang = l
        return (System.nanoTime() - t0) / 1_000_000
    }

    private class Img(val w: Int, val h: Int, val px: ByteArray, val off: Int) {
        /** Channel value 0..255 at integer pixel (c: 0=R,1=G,2=B). */
        fun v(x: Int, y: Int, c: Int): Float = (px[off + (y * w + x) * 4 + c].toInt() and 0xFF).toFloat()
        fun bilinear(fx0: Float, fy0: Float, c: Int): Float {
            val fx = fx0.coerceIn(0f, w - 1.001f); val fy = fy0.coerceIn(0f, h - 1.001f)
            val ix = fx.toInt(); val iy = fy.toInt(); val ax = fx - ix; val ay = fy - iy
            val ix1 = min(w - 1, ix + 1); val iy1 = min(h - 1, iy + 1)
            return (1 - ay) * ((1 - ax) * v(ix, iy, c) + ax * v(ix1, iy, c)) + ay * ((1 - ax) * v(ix, iy1, c) + ax * v(ix1, iy1, c))
        }
    }

    private data class Pt(val x: Float, val y: Float)

    // ---------- detection ----------
    private fun hull(pts: List<Pt>): List<Pt> {
        val p = pts.sortedWith(compareBy<Pt>({ it.x }, { it.y }))
        fun cr(o: Pt, a: Pt, b: Pt) = (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
        val lo = ArrayList<Pt>(); val up = ArrayList<Pt>()
        for (x in p) { while (lo.size >= 2 && cr(lo[lo.size - 2], lo[lo.size - 1], x) <= 0) lo.removeAt(lo.size - 1); lo.add(x) }
        for (i in p.indices.reversed()) { val x = p[i]; while (up.size >= 2 && cr(up[up.size - 2], up[up.size - 1], x) <= 0) up.removeAt(up.size - 1); up.add(x) }
        return lo.dropLast(1) + up.dropLast(1)
    }

    private class Rect(val cx: Float, val cy: Float, val w: Float, val h: Float, val a: Float)

    private fun minRect(pts: List<Pt>): Rect {
        val h = hull(pts)
        if (h.size < 3) return Rect(pts[0].x, pts[0].y, 1f, 1f, 0f)
        var best = Rect(0f, 0f, 0f, 0f, 0f); var bestArea = Float.MAX_VALUE
        for (i in h.indices) {
            val p0 = h[i]; val p1 = h[(i + 1) % h.size]
            val a = atan2(p1.y - p0.y, p1.x - p0.x); val c = cos(a); val s = sin(a)
            var u0 = Float.MAX_VALUE; var u1 = -Float.MAX_VALUE; var v0 = Float.MAX_VALUE; var v1 = -Float.MAX_VALUE
            for (q in h) { val u = q.x * c + q.y * s; val v = -q.x * s + q.y * c; u0 = min(u0, u); u1 = max(u1, u); v0 = min(v0, v); v1 = max(v1, v) }
            val area = (u1 - u0) * (v1 - v0)
            if (area < bestArea) {
                bestArea = area
                val um = (u0 + u1) / 2; val vm = (v0 + v1) / 2
                best = Rect(um * c - vm * s, um * s + vm * c, u1 - u0, v1 - v0, a)
            }
        }
        return best
    }

    private fun detect(img: Img, limit: Int): List<Array<Pt>> {
        val r = min(1f, limit.toFloat() / max(img.w, img.h))
        val nw = max(32, ((img.w * r) / 32).roundToInt() * 32); val nh = max(32, ((img.h * r) / 32).roundToInt() * 32)
        val plane = nw * nh
        val x = FloatArray(3 * plane)
        val mean = floatArrayOf(0.485f, 0.456f, 0.406f); val std = floatArrayOf(0.229f, 0.224f, 0.225f)
        val sx = img.w.toFloat() / nw; val sy = img.h.toFloat() / nh
        for (yy in 0 until nh) {
            val fy = (yy + 0.5f) * sy - 0.5f
            for (xx in 0 until nw) {
                val fx = (xx + 0.5f) * sx - 0.5f; val o = yy * nw + xx
                for (k in 0 until 3) x[k * plane + o] = (img.bilinear(fx, fy, 2 - k) / 255f - mean[k]) / std[k] // BGR
            }
        }
        val prob = OnnxTensor.createTensor(env, FloatBuffer.wrap(x), longArrayOf(1, 3, nh.toLong(), nw.toLong())).use { t ->
            det!!.run(mapOf("x" to t)).use { res ->
                val fb = (res[0] as OnnxTensor).floatBuffer
                FloatArray(fb.remaining()).also { fb.get(it) }
            }
        }
        val lab = IntArray(plane); val stack = IntArray(plane); val out = ArrayList<Array<Pt>>()
        var n = 0
        for (s in 0 until plane) {
            if (prob[s] <= 0.3f || lab[s] != 0) continue
            n++
            val pts = ArrayList<Pt>(); var sum = 0f; var sp = 0
            lab[s] = n; stack[sp++] = s
            while (sp > 0) {
                val i = stack[--sp]; val px = i % nw; val py = i / nw
                pts.add(Pt(px + 0.5f, py + 0.5f)); sum += prob[i]
                for (dy in -1..1) for (dx in -1..1) {
                    val qx = px + dx; val qy = py + dy
                    if (qx < 0 || qy < 0 || qx >= nw || qy >= nh) continue
                    val j = qy * nw + qx
                    if (lab[j] == 0 && prob[j] > 0.3f) { lab[j] = n; stack[sp++] = j }
                }
            }
            if (pts.size < 10 || sum / pts.size < 0.6f) continue
            val m = minRect(pts)
            val d = m.w * m.h * 1.5f / (2 * (m.w + m.h)) // unclip
            val w = m.w + 2 * d; val h = m.h + 2 * d
            if (min(w, h) < 3) continue
            val c = cos(m.a); val si = sin(m.a)
            fun corner(u: Float, v: Float) = Pt((m.cx + u * c - v * si) * sx, (m.cy + u * si + v * c) * sy)
            out.add(arrayOf(corner(-w / 2, -h / 2), corner(w / 2, -h / 2), corner(w / 2, h / 2), corner(-w / 2, h / 2)))
        }
        return out
    }

    /**
     * Join boxes the detector split within one line of text ("Tan Chee" + "Kin"): level boxes sharing most of
     * their height and less than 1.5 line-heights apart become one (same rule as ppocr.worker.ts).
     */
    private fun mergeLine(qs: List<Array<Pt>>): List<Array<Pt>> {
        class B(val x0: Float, val y0: Float, val x1: Float, val y1: Float, val q: Array<Pt>, val level: Boolean)
        val bs = qs.map { q ->
            val a = atan2(q[1].y - q[0].y, q[1].x - q[0].x)
            B(q.minOf { it.x }, q.minOf { it.y }, q.maxOf { it.x }, q.maxOf { it.y }, q,
                kotlin.math.abs(a) < 0.1f && dist(q[0], q[1]) >= dist(q[0], q[3]))
        }.toMutableList()
        var changed = true
        while (changed) {
            changed = false
            loop@ for (i in bs.indices) for (j in bs.indices) {
                val a = bs[i]; val b = bs[j]
                if (i == j || !a.level || !b.level || a.x0 > b.x0) continue
                val ha = a.y1 - a.y0; val hb = b.y1 - b.y0
                val ov = min(a.y1, b.y1) - max(a.y0, b.y0)
                if (ov < 0.6f * min(ha, hb) || max(ha, hb) > 1.6f * min(ha, hb)) continue
                if (b.x0 - a.x1 > 1.5f * max(ha, hb)) continue
                val x0 = a.x0; val y0 = min(a.y0, b.y0); val x1 = max(a.x1, b.x1); val y1 = max(a.y1, b.y1)
                val m = B(x0, y0, x1, y1, arrayOf(Pt(x0, y0), Pt(x1, y0), Pt(x1, y1), Pt(x0, y1)), true)
                bs.removeAt(max(i, j)); bs.removeAt(min(i, j)); bs.add(m)
                changed = true
                break@loop
            }
        }
        return bs.map { it.q }
    }

    // ---------- recognition ----------
    private fun dist(a: Pt, b: Pt) = hypot(a.x - b.x, a.y - b.y)

    /** Corners for reading: clockwise from top-left; a tall box (sideways text) starts so its long side is the width. */
    private fun readingOrder(q: Array<Pt>): Array<Pt> {
        val cx = q.sumOf { it.x.toDouble() }.toFloat() / 4; val cy = q.sumOf { it.y.toDouble() }.toFloat() / 4
        var c = q.sortedBy { atan2(it.y - cy, it.x - cx) }
        var k = 0
        for (i in 1 until 4) if (c[i].x + c[i].y < c[k].x + c[k].y) k = i
        c = (0 until 4).map { c[(it + k) % 4] }
        if (dist(c[0], c[3]) > 1.5f * dist(c[0], c[1])) c = listOf(c[3], c[0], c[1], c[2])
        return c.toTypedArray()
    }

    private fun strip(img: Img, q: Array<Pt>, outW: Int): FloatArray {
        val H = 48; val x = FloatArray(3 * H * outW)
        for (y in 0 until H) {
            val v = (y + 0.5f) / H
            val lx = q[0].x + (q[3].x - q[0].x) * v; val ly = q[0].y + (q[3].y - q[0].y) * v
            val rx = q[1].x + (q[2].x - q[1].x) * v; val ry = q[1].y + (q[2].y - q[1].y) * v
            for (xx in 0 until outW) {
                val u = (xx + 0.5f) / outW
                val fx = lx + (rx - lx) * u - 0.5f; val fy = ly + (ry - ly) * u - 0.5f
                for (k in 0 until 3) x[k * H * outW + y * outW + xx] = (img.bilinear(fx, fy, 2 - k) / 255f - 0.5f) / 0.5f
            }
        }
        return x
    }

    private fun flipStrip(x: FloatArray, w: Int): FloatArray {
        val o = FloatArray(x.size); val plane = 48 * w
        for (k in 0 until 3) for (i in 0 until plane) o[k * plane + i] = x[k * plane + plane - 1 - i]
        return o
    }

    private class Rec(val text: String, val conf: Float, val chars: List<Triple<String, Float, Float>>)

    // Threads reading line batches side by side (recognition), one ONNX Runtime run each.
    private val recPool by lazy { Executors.newFixedThreadPool(recThreads) { r -> ocrThread(r, "umbra-rec").apply { isDaemon = true } } }

    private fun recognise(strips: List<FloatArray>, widths: IntArray): Array<Rec> {
        val res = arrayOfNulls<Rec>(strips.size)
        val order = strips.indices.sortedBy { widths[it] }
        // One line per run with the Chinese model: its output has 18,385 classes per step (about 20 MB per
        // line), and batches of it ran 1.7x slower (desktop measurement).
        val most = if (chars.size > 1000) 1 else BATCH
        val batches = ArrayList<MutableList<Int>>()
        for (i in order) {
            val b = batches.lastOrNull()
            if (b != null && b.size < most && widths[i] <= 1.15f * widths[b[0]]) b.add(i) else batches.add(mutableListOf(i))
        }
        // Widest batches first, so the last ones to finish are short.
        batches.sortByDescending { idx -> idx.size * widths[idx.last()] }
        batches.map { idx -> recPool.submit { readBatch(idx, strips, widths, res) } }.forEach { f ->
            try { f.get() } catch (e: ExecutionException) { throw e.cause ?: e }
        }
        return res.map { it!! }.toTypedArray()
    }

    private fun readBatch(idx: List<Int>, strips: List<FloatArray>, widths: IntArray, res: Array<Rec?>) {
        val maxW = idx.maxOf { widths[it] }
        val x = FloatArray(idx.size * 3 * 48 * maxW)
        idx.forEachIndexed { b, i ->
            val one = strips[i]; val w = widths[i]
            for (k in 0 until 3) for (y in 0 until 48) System.arraycopy(one, k * 48 * w + y * w, x, b * 3 * 48 * maxW + k * 48 * maxW + y * maxW, w)
        }
        OnnxTensor.createTensor(env, FloatBuffer.wrap(x), longArrayOf(idx.size.toLong(), 3, 48, maxW.toLong())).use { t ->
            rec!!.run(mapOf("x" to t)).use { out ->
                val ot = out[0] as OnnxTensor
                val shape = ot.info.shape; val T = shape[1].toInt(); val C = shape[2].toInt()
                val fb = ot.floatBuffer; val p = FloatArray(fb.remaining()).also { fb.get(it) }
                idx.forEachIndexed { b, i ->
                    val used = widths[i].toFloat() / maxW * T
                    var prev = 0; val sb = StringBuilder(); var confSum = 0f; var n = 0; var gap = 0f; var gap0 = 0
                    val cs = ArrayList<Triple<String, Float, Float>>()
                    for (tt in 0 until T) {
                        var best = 0; var bv = -1f; val o = (b * T + tt) * C
                        for (c in 0 until C) if (p[o + c] > bv) { bv = p[o + c]; best = c }
                        if (best != 0 && best != prev) {
                            val ch = chars.getOrElse(best - 1) { "" }
                            // The Chinese model often leaves out the space between English words, but still gives
                            // it some weight in the gap: a likely space there is written (as ppocr.pipeline.ts).
                            if (gap >= SPACE_IN_GAP && ch != " " && cs.isNotEmpty() && cs.last().first != " ") {
                                sb.append(' '); cs.add(Triple(" ", min(1f, gap0 / used), min(1f, tt / used)))
                            }
                            sb.append(ch); confSum += bv; n++
                            cs.add(Triple(ch, min(1f, tt / used), min(1f, (tt + 1) / used)))
                            gap = 0f
                        } else if (best != 0 && best == prev && cs.isNotEmpty()) {
                            val l = cs.removeAt(cs.size - 1); cs.add(Triple(l.first, l.second, min(1f, (tt + 1) / used)))
                        } else if (best == 0) {
                            if (prev != 0) gap0 = tt
                            gap = max(gap, p[o + C - 1])
                        }
                        prev = best
                    }
                    res[i] = Rec(sb.toString(), if (n == 0) 0f else confSum / n, cs)
                }
            }
        }
    }

    /** One image to read: RGBA pixels at `off`, detection run at most `limit` px on the long side. */
    class Block(val w: Int, val h: Int, val limit: Int, val px: ByteArray, val off: Int)

    /** Full read of one image. Returns the JSON reply for JS ({id, ok, lines, ms}). */
    fun run(id: Int, w: Int, h: Int, limit: Int, px: ByteArray, off: Int): String = runAll(listOf(Block(w, h, limit, px, off)), id)[0]

    /**
     * Read several images (the blocks of print on one page): text is found in each in turn, then all their
     * lines are read together, spread over the cores. One JSON reply per image, as `run`; the page's
     * recognition time is reported on the first image (rec and retry 0 on the others).
     */
    fun runAll(blocks: List<Block>, id: Int = 0): List<String> {
        val load = ensureLoaded()
        class B(val img: Img, val quads: MutableList<Array<Pt>>, val widths: IntArray, val strips: List<FloatArray>, val det: Long) {
            lateinit var recs: Array<Rec>
            var flipped = false
        }
        val bs = blocks.map { b ->
            val img = Img(b.w, b.h, b.px, b.off)
            val t0 = System.nanoTime()
            val quads = mergeLine(detect(img, b.limit)).map { readingOrder(it) }.toMutableList()
            val widths = IntArray(quads.size) { i ->
                val q = quads[i]
                (48f * max(dist(q[0], q[1]), 1f) / max(dist(q[0], q[3]), 1f)).roundToInt().coerceIn(16, 2400)
            }
            val strips = quads.mapIndexed { i, q -> strip(img, q, widths[i]) }
            B(img, quads, widths, strips, (System.nanoTime() - t0) / 1_000_000)
        }
        val t1 = System.nanoTime()
        val all = recognise(bs.flatMap { it.strips }, bs.flatMap { it.widths.asList() }.toIntArray())
        var k = 0
        for (b in bs) { b.recs = all.copyOfRange(k, k + b.strips.size); k += b.strips.size }
        val t2 = System.nanoTime()
        // Upside down: if most long lines of a block read poorly, read all of it again turned 180°. Else retry a few weak lines.
        class Again(val b: B, val i: Int, val whole: Boolean)
        val again = ArrayList<Again>()
        for (b in bs) {
            val long = b.widths.indices.filter { b.widths[it] >= 96 }
            val weak = long.filter { b.recs[it].conf < 0.7f }
            if (long.size >= 3 && weak.size > long.size / 2) b.strips.indices.forEach { again.add(Again(b, it, true)) }
            else weak.take(6).forEach { again.add(Again(b, it, false)) }
        }
        if (again.isNotEmpty()) {
            val r = recognise(again.map { flipStrip(it.b.strips[it.i], it.b.widths[it.i]) }, IntArray(again.size) { again[it].b.widths[again[it].i] })
            fun turn(q: Array<Pt>) = arrayOf(q[2], q[3], q[0], q[1])
            for (b in bs) {
                val idx = again.indices.filter { again[it].b === b }
                if (idx.isEmpty()) continue
                if (again[idx[0]].whole) {
                    val long = b.widths.indices.filter { b.widths[it] >= 96 }
                    val flip = Array(b.strips.size) { i -> r[idx[i]] }
                    if (long.map { flip[it].conf }.average() > long.map { b.recs[it].conf }.average() + 0.1) {
                        b.recs = flip; b.flipped = true
                        for (i in b.quads.indices) b.quads[i] = turn(b.quads[i])
                    }
                } else for (j in idx) {
                    val i = again[j].i
                    if (r[j].conf > b.recs[i].conf + 0.1f) { b.recs[i] = r[j]; b.quads[i] = turn(b.quads[i]) }
                }
            }
        }
        val t3 = System.nanoTime()
        val ms = { a: Long, z: Long -> (z - a) / 1_000_000 }
        return bs.mapIndexed { n, b -> reply(id, b.quads, b.recs, load, b.det, if (n == 0) ms(t1, t2) else 0, if (n == 0) ms(t2, t3) else 0, b.flipped) }
    }

    private fun reply(id: Int, quads: List<Array<Pt>>, recs: Array<Rec>, load: Long, det: Long, rec: Long, retry: Long, flipped: Boolean): String {
        val sb = StringBuilder(4096)
        sb.append("{\"id\":").append(id).append(",\"ok\":true,\"lines\":[")
        var first = true
        for (i in quads.indices) {
            val r = recs[i]
            if (r.text.isBlank() || r.conf < 0.5f) continue
            if (!first) sb.append(','); first = false
            sb.append("{\"quad\":[")
            quads[i].forEachIndexed { k, p -> if (k > 0) sb.append(','); sb.append('[').append(p.x).append(',').append(p.y).append(']') }
            sb.append("],\"text\":").append(quote(r.text)).append(",\"conf\":").append(r.conf).append(",\"chars\":[")
            r.chars.forEachIndexed { k, c -> if (k > 0) sb.append(','); sb.append("{\"c\":").append(quote(c.first)).append(",\"u0\":").append(c.second).append(",\"u1\":").append(c.third).append('}') }
            sb.append("]}")
        }
        sb.append("],\"ms\":{\"load\":").append(load).append(",\"det\":").append(det).append(",\"rec\":").append(rec)
            .append(",\"retry\":").append(retry).append(",\"lines\":").append(quads.size).append(",\"threads\":").append(threads)
            .append(",\"flipped\":").append(flipped).append("}}")
        return sb.toString()
    }

    private fun quote(t: String): String {
        val sb = StringBuilder(t.length + 2).append('"')
        for (ch in t) when {
            ch == '"' -> sb.append("\\\"")
            ch == '\\' -> sb.append("\\\\")
            ch < ' ' -> sb.append(String.format("\\u%04x", ch.code))
            else -> sb.append(ch)
        }
        return sb.append('"').toString()
    }

    fun close() { det?.close(); rec?.close(); det = null; rec = null; recLang = null }

    companion object {
        /**
         * OCR threads run a little below normal priority, so the screen (scrolling, the panel, animations) gets a core
         * the moment it needs one. They lose almost nothing when the screen is still. Kept under
         * THREAD_PRIORITY_BACKGROUND (10), which would also move them to the slow cores.
         */
        const val OCR_PRIORITY = 4

        /** A thread at [OCR_PRIORITY]. ONNX Runtime's own threads, started from one, inherit it. */
        fun ocrThread(r: Runnable, name: String) = Thread({ android.os.Process.setThreadPriority(OCR_PRIORITY); r.run() }, name)

        private const val BATCH = 4 // lines per recognition run
        /** Space weight in a gap between two characters above which a space is written (the space is the last class). */
        private const val SPACE_IN_GAP = 0.05f

        /** Cores within 70% of the fastest core's top speed (all of them if the speeds can't be read). */
        fun fastCores(): Int {
            val n = Runtime.getRuntime().availableProcessors()
            val f = (0 until n).mapNotNull { i ->
                try { java.io.File("/sys/devices/system/cpu/cpu$i/cpufreq/cpuinfo_max_freq").readText().trim().toLong() } catch (_: Throwable) { null }
            }
            if (f.size < n || f.isEmpty()) return n
            val top = f.max()
            return f.count { it >= top * 0.7 }
        }
    }
}
