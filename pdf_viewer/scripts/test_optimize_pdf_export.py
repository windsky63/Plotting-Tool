import tempfile
from pathlib import Path
import fitz
from optimize_pdf_export import optimize, attachments


def test():
    with tempfile.TemporaryDirectory(prefix='luotu-optimize-test-') as folder:
        source, target = Path(folder) / 'input.pdf', Path(folder) / 'output.pdf'
        doc = fitz.open()
        for i in range(8):
            page = doc.new_page(width=300, height=400)
            page.insert_text((20, 30), 'PAGE %d' % i)
            # Independent images with identical stream data and dictionaries.
            pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 128, 128), False)
            pix.clear_with(180)
            page.insert_image(fitz.Rect(40, 80, 240, 280), pixmap=pix)
        image = doc[0].get_images()[0][0]
        for i in range(len(doc)):
            duplicate = doc.get_new_xref()
            doc.update_object(duplicate, doc.xref_object(image))
            doc.update_stream(duplicate, doc.xref_stream(image), compress=False)
            resources = int(doc.xref_get_key(doc[i].xref, 'Resources')[1].split()[0])
            doc.xref_set_key(resources, 'XObject/' + doc[i].get_images()[0][7], '%d 0 R' % duplicate)
        doc.embfile_add('annotations.json', b'{"annotations":[{"id":"LATEST"}]}')
        doc.embfile_add('other.txt', b'keep this attachment')
        orphan = doc.get_new_xref(); doc.update_object(orphan, '<<>>'); doc.update_stream(orphan, b'OBSOLETE_JSON', compress=False)
        doc.set_toc([[1, 'Drawing', 1]])
        doc.save(source)
        doc.close()
        marker = b'\n%LUOTU_DRAFT_IDENTITY_V1:eyJ0ZXN0IjoxfQ==\n'
        with source.open('ab') as stream: stream.write(marker)
        optimize(str(source), str(target))
        with fitz.open(source) as before, fitz.open(target) as after:
            assert attachments(before) == attachments(after)
            assert len({after[i].get_images()[0][0] for i in range(len(after))}) == 1
            assert after.embfile_get('annotations.json') == b'{"annotations":[{"id":"LATEST"}]}'
        assert b'OBSOLETE_JSON' not in target.read_bytes()
        assert target.read_bytes().endswith(marker)
        assert target.stat().st_size < source.stat().st_size
        print('PASS repeated images, orphan removal, JSON, other attachment, bookmarks, identity, every-page render')
        print('bytes', source.stat().st_size, '->', target.stat().st_size)


if __name__ == '__main__':
    test()
