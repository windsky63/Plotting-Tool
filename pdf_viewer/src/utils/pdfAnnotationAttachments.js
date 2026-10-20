// Read the reachable attachment tree. An orphan Filespec is never a fallback
// for a valid directory: it may refer to a replaced annotations.json.
export async function readPdfAnnotationAttachment(pdfDoc, pdfLib, inflate) {
  const {PDFName, decodePDFRawStream} = pdfLib;
  const lookup = value => value ? pdfDoc.context.lookup(value) : null;
  const get = (dict, name) => lookup(dict)?.get?.(PDFName.of(name));
  const items = array => {
    const value = lookup(array);
    if (Array.isArray(value)) return value;
    return Array.from({length: value?.size?.() || 0}, (_, i) => value.get(i));
  };
  const readSpec = spec => {
    const dict = lookup(spec), name = lookup(get(dict, 'UF') || get(dict, 'F'));
    const filename = name?.decodeText?.() || name?.toString?.().replace(/[()]/g, '');
    if (filename !== 'annotations.json') return null;
    const stream = lookup(get(get(dict, 'EF'), 'F'));
    if (!stream) throw new Error('annotations.json 附件内容缺失');
    let bytes = stream.contents || stream.getContents?.();
    if (decodePDFRawStream) bytes = decodePDFRawStream(stream).decode();
    else if (get(stream.dict, 'Filter')?.toString?.().includes('FlateDecode')) {
      if (!inflate) throw new Error('无法解压 annotations.json');
      bytes = inflate(bytes);
    }
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(data.annotations)) throw new Error('annotations.json 标注数据无效');
    return data;
  };
  const directory = get(get(pdfDoc.catalog, 'Names'), 'EmbeddedFiles');
  if (directory) {
    const visited = new Set(), queue = [directory];
    while (queue.length) {
      const node = lookup(queue.shift());
      if (!node || visited.has(node)) continue;
      visited.add(node);
      const names = items(get(node, 'Names'));
      for (let i = 1; i < names.length; i += 2) {
        const data = readSpec(names[i]); if (data) return data;
      }
      queue.push(...items(get(node, 'Kids')));
    }
    return null;
  }
  // Some legacy exports omit Names and expose their attachments through AF.
  for (const spec of items(get(pdfDoc.catalog, 'AF'))) {
    const data = readSpec(spec); if (data) return data;
  }
  return null;
}

export async function readPdfEditableAnnotations(pdfDoc, pdfLib, inflate) {
  const keywords = pdfDoc.getKeywords();
  const text = Array.isArray(keywords) ? keywords.join(' ') : (keywords || '');
  const match = text.match(/ANNOTATION_DATA:([^:]+):([^:]+):(.+)/);
  if (match && match[3] !== 'ATTACHMENT') {
    const data = JSON.parse(match[3]);
    if (!Array.isArray(data.annotations)) throw new Error('PDF 内标注数据无效');
    return data;
  }
  const data = await readPdfAnnotationAttachment(pdfDoc, pdfLib, inflate);
  if (!data && match?.[3] === 'ATTACHMENT') throw new Error('当前附件目录中未找到 annotations.json，请通过恢复入口选择草稿');
  return data;
}
