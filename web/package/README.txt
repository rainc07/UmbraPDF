Umbra PDF (desktop)
===================

Start: {launcher}
Umbra PDF opens in your browser at http://127.0.0.1:5180/. Close its window (or press Ctrl+C) to stop it.

Everything stays on this computer: the server only answers this computer (127.0.0.1), and nothing is uploaded.

Settings (settings.json in this folder, restart Umbra PDF after a change):
  port     Port to use (default 5180). If another program already uses it, Umbra PDF takes the next free one
           (5181, 5182, ...). Your Umbra settings are stored by the browser per address, so pick a free port here
           if you want them to stay put.
  threads  CPU threads for text recognition (null = automatic, up to 8).
  gpu      true = try the GPU (DirectML, Windows). The CPU is usually faster.

Source code and licence (GPL-3.0-or-later): https://github.com/rainc07/UmbraPDF
Third-party licences: THIRD_PARTY_NOTICES.md, node/LICENSE, node_modules/*/LICENSE
