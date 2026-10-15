package app.umbrapdf

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class LocalFileStoreTest {
    @Test
    fun releaseDeletesFile() {
        val store = LocalFileStore(Files.createTempDirectory("umbra").toFile())
        val (token, file) = store.newFile()
        file.writeText("x")
        assertTrue(file.exists())
        store.release(token)
        assertFalse(file.exists())
        assertNull(store.get(token))
    }
}
