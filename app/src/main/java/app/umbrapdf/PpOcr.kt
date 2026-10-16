// SPDX-License-Identifier: GPL-3.0-or-later
package app.umbrapdf

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.nio.FloatBuffer
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
 * `load` returns a model file's bytes by name (det.onnx, rec_en.onnx, dict_en.txt).
 */
class PpOcr(private val load: (String) -> ByteArray) {
    private val env: OrtEnvironment = OrtEnvironment.getEnvironment()
    private var det: OrtSession? = null
    private var rec: OrtSession? = null
    private var chars: List<String> = emptyList()
    val threads = max(1, min(4, Runtime.getRuntime().availableProcessors()))

    @Synchronized
    fun ensureLoaded(): Long {
        if (det != null) return 0
        val t0 = System.nanoTime()
        val opts = OrtSession.SessionOptions().apply {
            setIntraOpNumThreads(threads)
            setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
        }
        fun asset(n: String) = load(n)
        det = env.createSession(asset("det.onnx"), opts)
        rec = env.createSession(asset("rec_en.onnx"), opts)
        val lines = String(asset("dict_en.txt"), Charsets.UTF_8).split("\n").map { it.trimEnd('\r') }.toMutableList()
        if (lines.isNotEmpty() && lines.last().isEmpty()) lines.removeAt(lines.size - 1)
        chars = lines + " "
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

    private fun recognise(strips: List<FloatArray>, widths: IntArray): Array<Rec> {
        val res = arrayOfNulls<Rec>(strips.size)
        val order = strips.indices.sortedBy { widths[it] }
        val batches = ArrayList<MutableList<Int>>()
        for (i in order) {
            val b = batches.lastOrNull()
            if (b != null && b.size < 8 && widths[i] <= 1.3f * widths[b[0]]) b.add(i) else batches.add(mutableListOf(i))
        }
        for (idx in batches) {
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
                        var prev = 0; val sb = StringBuilder(); var confSum = 0f
                        val cs = ArrayList<Triple<String, Float, Float>>()
                        for (tt in 0 until T) {
                            var best = 0; var bv = -1f; val o = (b * T + tt) * C
                            for (c in 0 until C) if (p[o + c] > bv) { bv = p[o + c]; best = c }
                            if (best != 0 && best != prev) {
                                val ch = chars.getOrElse(best - 1) { "" }
                                sb.append(ch); confSum += bv
                                cs.add(Triple(ch, min(1f, tt / used), min(1f, (tt + 1) / used)))
                            } else if (best != 0 && best == prev && cs.isNotEmpty()) {
                                val l = cs.removeAt(cs.size - 1); cs.add(Triple(l.first, l.second, min(1f, (tt + 1) / used)))
                            }
                            prev = best
                        }
                        res[i] = Rec(sb.toString(), if (cs.isEmpty()) 0f else confSum / cs.size, cs)
                    }
                }
            }
        }
        return res.map { it!! }.toTypedArray()
    }

    /** Full read of one image. Returns the JSON reply for JS ({id, ok, lines, ms}). */
    fun run(id: Int, w: Int, h: Int, limit: Int, px: ByteArray, off: Int): String {
        val load = ensureLoaded()
        val img = Img(w, h, px, off)
        val t0 = System.nanoTime()
        val quads = detect(img, limit).map { readingOrder(it) }.toMutableList()
        val widths = IntArray(quads.size) { i ->
            val q = quads[i]
            (48f * max(dist(q[0], q[1]), 1f) / max(dist(q[0], q[3]), 1f)).roundToInt().coerceIn(16, 2400)
        }
        val strips = quads.mapIndexed { i, q -> strip(img, q, widths[i]) }
        val t1 = System.nanoTime()
        var recs = if (strips.isEmpty()) emptyArray() else recognise(strips, widths)
        // Upside down: if most long lines read poorly, read all again turned 180°. Else retry a few weak lines.
        val long = widths.indices.filter { widths[it] >= 96 }
        var weak = long.filter { recs[it].conf < 0.7f }
        var flipped = false
        val t2 = System.nanoTime()
        if (long.size >= 3 && weak.size > long.size / 2) {
            val again = recognise(strips.mapIndexed { i, s -> flipStrip(s, widths[i]) }, widths)
            fun mean(r: Array<Rec>) = long.map { r[it].conf }.average()
            if (mean(again) > mean(recs) + 0.1) { recs = again; flipped = true; for (i in quads.indices) quads[i] = arrayOf(quads[i][2], quads[i][3], quads[i][0], quads[i][1]) }
            weak = emptyList()
        }
        weak = weak.take(6)
        if (weak.isNotEmpty()) {
            val again = recognise(weak.map { flipStrip(strips[it], widths[it]) }, IntArray(weak.size) { widths[weak[it]] })
            weak.forEachIndexed { k, i -> if (again[k].conf > recs[i].conf + 0.1f) { recs[i] = again[k]; quads[i] = arrayOf(quads[i][2], quads[i][3], quads[i][0], quads[i][1]) } }
        }
        val t3 = System.nanoTime()
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
        val ms = { a: Long, b: Long -> (b - a) / 1_000_000 }
        sb.append("],\"ms\":{\"load\":").append(load).append(",\"det\":").append(ms(t0, t1)).append(",\"rec\":").append(ms(t1, t2))
            .append(",\"retry\":").append(ms(t2, t3)).append(",\"lines\":").append(quads.size).append(",\"threads\":").append(threads)
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

    fun close() { det?.close(); rec?.close(); det = null; rec = null }
}
