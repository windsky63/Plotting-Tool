"""Lossless rewrite only; reject output that fails document/attachment checks."""
import hashlib
import json
import math
import re
import sys
import fitz


def attachments(doc):
    result = []
    for i in range(doc.embfile_count()):
        info = doc.embfile_info(i)
        result.append((info.get('name'), info.get('filename'),
                       hashlib.sha256(doc.embfile_get(i)).hexdigest()))
    return result


def page_signature(page):
    # Bounded validation raster; no full-resolution image accumulation.
    scale = min(1, math.sqrt(500000 / max(1, page.rect.width * page.rect.height)))
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=True)
    digest = hashlib.sha256(pix.samples).hexdigest()
    return (tuple(page.mediabox), tuple(page.cropbox), page.rotation,
            page.get_text(), pix.width, pix.height, digest)


def optimize(source, target):
    with open(source, 'rb') as stream:
        stream.seek(0, 2)
        size = stream.tell()
        stream.seek(max(0, size - 65536))
        identities = re.findall(rb'%LUOTU_DRAFT_IDENTITY_V1:[^\r\n]+', stream.read())
    with fitz.open(source) as doc:
        if doc.is_encrypted or doc.get_sigflags() > 0:
            raise ValueError('Encrypted or signed PDF: preserve original export')
        original_attachments = attachments(doc)
        annotation_names = [item[0] for item in original_attachments if item[0] == 'annotations.json']
        if len(annotation_names) > 1:
            raise ValueError('Ambiguous annotation attachments')
        doc.save(target, garbage=4, deflate=True, incremental=False, no_new_id=True)
        with fitz.open(target) as result:
            if len(doc) != len(result) or doc.metadata != result.metadata:
                raise ValueError('Page count or metadata changed')
            if doc.get_toc() != result.get_toc() or original_attachments != attachments(result):
                raise ValueError('Bookmarks or attachments changed')
            for index in range(len(doc)):
                if page_signature(doc[index]) != page_signature(result[index]):
                    raise ValueError('Page validation failed: %d' % (index + 1))
                fitz.TOOLS.store_shrink(100)
    if identities:
        with open(target, 'ab') as stream:
            stream.write(b'\n' + identities[-1] + b'\n')
    return {'validated': True}


if __name__ == '__main__':
    print(json.dumps(optimize(sys.argv[1], sys.argv[2])))
