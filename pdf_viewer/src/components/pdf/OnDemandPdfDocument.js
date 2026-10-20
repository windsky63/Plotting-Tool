import React, {createContext, useContext, useEffect, useRef, useState} from 'react';
import {Document, Page, pdfjs} from 'react-pdf';
import {createOnDemandPdfDocument} from '../../utils/onDemandPdfDocument';
import {REMOTE_PAGE_FALLBACK_MS} from '../../utils/remotePageLoading';

const OnDemandContext = createContext(null);

export function OnDemandPdfPage(props) {
  const pdf = useContext(OnDemandContext);
  return <Page {...props} {...(pdf ? {pdf, suspense: false} : {})} />;
}

function BrowserDocument({file, knownPageCount, eager, onLoadSuccess, onLoadError, children, loading, error}) {
  const callbacks = useRef({onLoadSuccess, onLoadError});
  callbacks.current = {onLoadSuccess, onLoadError};
  const [state, setState] = useState({file: null, pdf: null, ready: false, failed: false});
  useEffect(() => {
    let live = true;
    const pdf = createOnDemandPdfDocument({file, pdfjs,
      onReady: document => {
        if (!live) return;
        setState(previous => ({...previous, ready: true, failed: false}));
        callbacks.current.onLoadSuccess(document);
      },
      onState: diagnostic => {
        if (live) window.__luotuOnDemandPdf = {...diagnostic, fileBytes: Number(file?.size || 0)};
      }
    });
    setState({file, pdf, ready: false, failed: false});
    return () => { live = false; void pdf.destroy(); };
  }, [file]);
  const pdf = state.file === file ? state.pdf : null;
  useEffect(() => {
    if (!pdf) return undefined;
    pdf.setPageCount(Number(knownPageCount));
    if (!eager && Number(knownPageCount) > 0) return undefined;
    let cancelled = false;
    // Cached metadata gets the same 700 ms opportunity as the page image.
    const timer = setTimeout(() => {
      pdf.ensure().catch(reason => {
        if (cancelled || reason?.name === 'AbortError') return;
        setState(previous => previous.pdf === pdf ? {...previous, failed: true} : previous);
        callbacks.current.onLoadError(reason);
      });
    }, eager ? 0 : REMOTE_PAGE_FALLBACK_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pdf, knownPageCount, eager]);
  return <div className="react-pdf__Document">
    {pdf && state.ready ? <OnDemandContext.Provider value={pdf}>{children}</OnDemandContext.Provider>
      : state.failed ? error : loading}
  </div>;
}

export function OnDemandPdfDocument({enabled, knownPageCount, eager, ...props}) {
  return enabled ? <BrowserDocument {...props} knownPageCount={knownPageCount} eager={eager} /> : <Document {...props} />;
}
