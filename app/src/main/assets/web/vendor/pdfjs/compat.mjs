// Small fill-ins for older Safari (iPhone/iPad), loaded before anything else in the page and in the pdf.js worker.
// Safari has no async iteration of ReadableStream (pdf.js reads page text and inflates data that way), and
// iOS before 18.4 lacks iterator helpers (map/filter/some/... on Map and Set iterators). Plain JS, no imports.
if (typeof ReadableStream !== 'undefined' && !ReadableStream.prototype[Symbol.asyncIterator]) {
  ReadableStream.prototype[Symbol.asyncIterator] = async function* () {
    const reader = this.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally { reader.releaseLock(); }
  };
}
{
  const proto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
  const add = (name, fn) => { if (!proto[name]) Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true }); };
  add('map', function* (f) { let i = 0; for (const x of this) yield f(x, i++); });
  add('filter', function* (f) { let i = 0; for (const x of this) if (f(x, i++)) yield x; });
  add('flatMap', function* (f) { let i = 0; for (const x of this) yield* f(x, i++); });
  add('take', function* (n) { if (n <= 0) return; for (const x of this) { yield x; if (--n <= 0) return; } });
  add('drop', function* (n) { for (const x of this) { if (n > 0) { n--; continue; } yield x; } });
  add('some', function (f) { let i = 0; for (const x of this) if (f(x, i++)) return true; return false; });
  add('every', function (f) { let i = 0; for (const x of this) if (!f(x, i++)) return false; return true; });
  add('find', function (f) { let i = 0; for (const x of this) if (f(x, i++)) return x; return undefined; });
  add('forEach', function (f) { let i = 0; for (const x of this) f(x, i++); });
  add('toArray', function () { return [...this]; });
  add('reduce', function (f, ...init) { let i = 0, it = this[Symbol.iterator](), acc;
    if (init.length) acc = init[0]; else { const r = it.next(); if (r.done) throw new TypeError('Reduce of empty iterator with no initial value'); acc = r.value; i = 1; }
    for (let r = it.next(); !r.done; r = it.next()) acc = f(acc, r.value, i++);
    return acc; });
}
