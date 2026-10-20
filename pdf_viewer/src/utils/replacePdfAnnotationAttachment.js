// Replace only our name-tree entry; retain bookmarks, named destinations and
// other attachments. Old unreachable streams are collected by server rewrite.
export function replacePdfAnnotationAttachment(doc, bytes, lib) {
  const {PDFName, PDFString, PDFDict, PDFArray} = lib;
  const context = doc.context;
  const name = value => PDFName.of(value);
  const resolve = value => value ? context.lookup(value) : undefined;
  const decode = value => value?.decodeText?.() || '';
  const names = resolve(doc.catalog.get(name('Names'))) || context.obj({});
  const entries = [], visited = new Set();
  const walk = node => {
    node = resolve(node);
    if (!(node instanceof PDFDict) || visited.has(node)) return;
    visited.add(node);
    const pairs = resolve(node.get(name('Names')));
    if (pairs instanceof PDFArray) for (let i = 0; i + 1 < pairs.size(); i += 2) {
      const key = pairs.get(i), ref = pairs.get(i + 1);
      const spec = resolve(ref);
      if (decode(key) !== 'annotations.json' && decode(spec?.get?.(name('F'))) !== 'annotations.json' &&
          decode(spec?.get?.(name('UF'))) !== 'annotations.json') entries.push([key, ref]);
    }
    const kids = resolve(node.get(name('Kids')));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(kids.get(i));
  };
  walk(names.get(name('EmbeddedFiles')));
  const stream = context.register(context.flateStream(bytes));
  const spec = context.register(context.obj({Type: name('Filespec'), F: PDFString.of('annotations.json'),
    UF: PDFString.of('annotations.json'), EF: {F: stream}}));
  // Associated-file entries must not keep old annotation attachments alive.
  for (const [, object] of context.enumerateIndirectObjects()) {
    const dict = object instanceof PDFDict ? object : object?.dict;
    const af = resolve(dict?.get?.(name('AF')));
    if (!(af instanceof PDFArray)) continue;
    for (let i = 0; i < af.size(); i++) {
      const old = resolve(af.get(i));
      if (decode(old?.get?.(name('F'))) === 'annotations.json' || decode(old?.get?.(name('UF'))) === 'annotations.json') af.set(i, spec);
    }
  }
  entries.push([PDFString.of('annotations.json'), spec]);
  entries.sort((a, b) => decode(a[0]) < decode(b[0]) ? -1 : decode(a[0]) > decode(b[0]) ? 1 : 0);
  names.set(name('EmbeddedFiles'), context.register(context.obj({Names: entries.flat()})));
  doc.catalog.set(name('Names'), names);
}
