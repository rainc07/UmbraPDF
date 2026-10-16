// SPDX-License-Identifier: GPL-3.0-or-later
package app.umbrapdf

import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test
import java.awt.Color
import java.awt.Font
import java.awt.RenderingHints
import java.awt.image.BufferedImage
import java.io.File

/**
 * Runs the native OCR code (PpOcr) on the build machine with the desktop ONNX Runtime and the bundled models.
 * FAKE data only. Checks: lines are found and read, positions are sane, upside-down pages are turned.
 */
class PpOcrTest {
    private val dir = File("src/main/assets/web/vendor/ppocr")
    private val ocr = PpOcr { n -> File(dir, n).readBytes() }

    private fun page(lines: List<String>, flip: Boolean = false): Triple<Int, Int, ByteArray> {
        val w = 1000; val h = 120 + lines.size * 70
        val img = BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB)
        val g = img.createGraphics()
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON)
        g.color = Color.WHITE; g.fillRect(0, 0, w, h)
        g.color = Color.BLACK; g.font = Font(Font.SANS_SERIF, Font.BOLD, 40)
        if (flip) { g.rotate(Math.PI, w / 2.0, h / 2.0) }
        lines.forEachIndexed { i, t -> g.drawString(t, 60, 100 + i * 70) }
        g.dispose()
        val px = ByteArray(w * h * 4)
        for (y in 0 until h) for (x in 0 until w) {
            val c = img.getRGB(x, y); val o = (y * w + x) * 4
            px[o] = (c shr 16 and 0xFF).toByte(); px[o + 1] = (c shr 8 and 0xFF).toByte(); px[o + 2] = (c and 0xFF).toByte(); px[o + 3] = 255.toByte()
        }
        return Triple(w, h, px)
    }

    private fun texts(json: String): List<String> {
        val r = JSONObject(json)
        assertTrue("ok: $json", r.getBoolean("ok"))
        val ls = r.getJSONArray("lines")
        return (0 until ls.length()).map { ls.getJSONObject(it).getString("text") }
    }

    @Test fun readsLines() {
        val (w, h, px) = page(listOf("KAD PENGENALAN", "851231-08-5014", "LEE CHONG HUAT"))
        val json = ocr.run(1, w, h, 960, px, 0)
        val t = texts(json)
        println("upright: $t  ${JSONObject(json).getJSONObject("ms")}")
        assertTrue(t.toString(), t.any { it.replace(" ", "") == "851231-08-5014" })
        assertTrue(t.toString(), t.any { it.contains("LEE CHONG HUAT") })
        val q = JSONObject(json).getJSONArray("lines").getJSONObject(0).getJSONArray("quad")
        assertTrue("quad has 4 corners", q.length() == 4)
    }

    @Test fun turnsUpsideDownText() {
        val (w, h, px) = page(listOf("KAD PENGENALAN MALAYSIA", "851231-08-5014", "LEE CHONG HUAT", "47300 PETALING JAYA"), flip = true)
        val json = ocr.run(2, w, h, 960, px, 0)
        val t = texts(json)
        println("flipped: $t  ${JSONObject(json).getJSONObject("ms")}")
        assertTrue(t.toString(), t.any { it.replace(" ", "") == "851231-08-5014" })
        assertTrue(JSONObject(json).getJSONObject("ms").getBoolean("flipped"))
    }
}
