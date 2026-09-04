// html2pdf.js ships no types. We use one entry point — the chained builder
// html2pdf().set(opts).from(el).save() — so that is all this declares.
declare module 'html2pdf.js' {
  interface Html2PdfWorker {
    set(opts: unknown): Html2PdfWorker;
    from(element: Element): Html2PdfWorker;
    save(): Promise<void>;
  }
  export default function html2pdf(): Html2PdfWorker;
}
