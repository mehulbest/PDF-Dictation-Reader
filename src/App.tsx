import { useEffect, useMemo, useRef, useState } from "react";
import "./index.css";

export default function PDFDictationReader() {
  const [pdfName, setPdfName] = useState("");
  const [numPages, setNumPages] = useState(0);
  const [textByPage, setTextByPage] = useState<string[]>([]);
  const [sentences, setSentences] = useState<{ text: string; page: number }[]>([]);
  const [currentSentence, setCurrentSentence] = useState(0);

  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string>("");
  const [volume, setVolume] = useState(1);
  const [mathMode, setMathMode] = useState(true);

  const [isLoading, setIsLoading] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const pdfjsRef = useRef<any>(null);

  // ---------- PDF.js (Vite + pdfjs-dist v4) ----------
  const loadPdfJs = async () => {
    if (pdfjsRef.current) return pdfjsRef.current;
    const pdfjs = await import("pdfjs-dist");
    const workerSrc = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    (pdfjs as any).GlobalWorkerOptions.workerSrc = (workerSrc as any).default;
    pdfjsRef.current = pdfjs;
    return pdfjs;
  };

  // ---------- Voices ----------
  useEffect(() => {
    const populate = () => {
      const v = window.speechSynthesis.getVoices();
      setVoices(v);
      const pref = v.find(vv => /en-/i.test(vv.lang))?.name;
      if (pref) setSelectedVoice(pref);
    };
    populate();
    window.speechSynthesis.onvoiceschanged = populate;
  }, []);

  // ---------- Keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") { e.preventDefault(); toggleSpeak(); }
      if (e.code === "ArrowRight") { e.preventDefault(); nextSentence(); }
      if (e.code === "ArrowLeft") { e.preventDefault(); prevSentence(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const fullTranscript = useMemo(() => textByPage.join("\n\n"), [textByPage]);
  const progressPct = sentences.length ? (currentSentence / (sentences.length - 1)) * 100 : 0;

  // ---------- Math normalizer (includes superscripts) ----------
  const normalizeForSpeech = (s: string) => {
    let t = s;
    // superscripts
    t = t.replace(/([a-zA-Z])²/g, "$1 squared")
         .replace(/([a-zA-Z])³/g, "$1 cubed")
         .replace(/([a-zA-Z])⁴/g, "$1 to the power of 4")
         .replace(/([a-zA-Z])⁵/g, "$1 to the power of 5")
         .replace(/([a-zA-Z])⁶/g, "$1 to the power of 6")
         .replace(/([a-zA-Z])⁷/g, "$1 to the power of 7")
         .replace(/([a-zA-Z])⁸/g, "$1 to the power of 8")
         .replace(/([a-zA-Z])⁹/g, "$1 to the power of 9")
         .replace(/([a-zA-Z])⁰/g, "$1 to the power of 0");

    // common operators
    t = t.replace(/[•·]/g, " ").replace(/=/g, " equals ")
         .replace(/\+/g, " plus ").replace(/[−–—-]/g, " minus ")
         .replace(/[×*]/g, " times ").replace(/(?<=\w)\/(?=\w)/g, " divided by ");

    // powers, roots, fractions, trig, logs, inequalities, calculus
    t = t.replace(/\b([a-zA-Z])\^2\b/g, "$1 squared")
         .replace(/\b([a-zA-Z])\^3\b/g, "$1 cubed")
         .replace(/\b([a-zA-Z])\^(\d+)\b/g, "$1 to the power of $2")
         .replace(/√\(?([^)]+)\)?/g, " square root of $1 ")
         .replace(/(\([^)]*\)|\S+)\/(\([^)]*\)|\S+)/g, "($1) over ($2)")
         .replace(/\bsin\(?([^)]+)?\)?/g, "sine of $1")
         .replace(/\bcos\(?([^)]+)?\)?/g, "cosine of $1")
         .replace(/\btan\(?([^)]+)?\)?/g, "tangent of $1")
         .replace(/\bln\(/g, " natural log of (")
         .replace(/\blog_?(\d+)?\(/g, " log base $1 of (")
         .replace(/≤/g, " less than or equal to ")
         .replace(/≥/g, " greater than or equal to ")
         .replace(/</g, " less than ")
         .replace(/>/g, " greater than ")
         .replace(/Σ/g, " sum of ").replace(/∫/g, " integral of ").replace(/lim/g, " limit ");

    return t.replace(/\s{2,}/g, " ").trim();
  };

  // ---------- Split into sentences ----------
  const buildSentences = (pages: string[]) => {
    const result: { text: string; page: number }[] = [];
    pages.forEach((txt, i) => {
      const cleaned = txt.replace(/\s+/g, " ").replace(/\.(?=\S)/g, ". ").trim();
      const chunks = cleaned
        .split(/(?<=[.!?])\s+(?=[A-Z0-9(\"'\[])/)
        .map(s => s.trim()).filter(Boolean);
      chunks.forEach(c => result.push({ text: c, page: i + 1 }));
    });
    return result;
  };

  // ---------- Extract text ----------
  const extractTextFromPdf = async (file: File) => {
    setIsLoading(true); setError(null); setPdfName(file.name); setCurrentSentence(0);
    try {
      const arrayBuf = await file.arrayBuffer();
      const pdfjs = await loadPdfJs();
      const pdf = await (pdfjs as any).getDocument({ data: arrayBuf }).promise;
      setNumPages(pdf.numPages);
      const pages: string[] = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        const strings = (content.items as any[]).map((it: any) => it.str ?? "");
        pages.push(strings.join(" "));
      }
      setTextByPage(pages);
      setSentences(buildSentences(pages));
    } catch (e) {
      console.error(e);
      setError("Failed to read PDF. Please try a different file.");
    } finally { setIsLoading(false); }
  };

  // ---------- TTS ----------
  const buildUtterance = (text: string) => {
    const u = new SpeechSynthesisUtterance(text);
    const v = voices.find(vv => vv.name === selectedVoice);
    if (v) u.voice = v;
    u.volume = volume;
    u.onstart = () => setIsSpeaking(true);
    u.onend = () => setIsSpeaking(false);
    u.onerror = () => setIsSpeaking(false);
    return u;
  };

  const startSpeakingFrom = (index: number) => {
    if (!sentences.length) return;
    window.speechSynthesis.cancel();
    setCurrentSentence(index);
    const raw = sentences[index].text;
    const text = mathMode ? normalizeForSpeech(raw) : raw;
    utteranceRef.current = buildUtterance(text);
    window.speechSynthesis.speak(utteranceRef.current);
    const el = listRef.current?.querySelector(`[data-sent-index="${index}"]`) as HTMLElement | null;
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const toggleSpeak = () => {
    if (!sentences.length) return;
    if (isSpeaking) { window.speechSynthesis.pause(); setIsSpeaking(false); }
    else {
      if (window.speechSynthesis.paused) { window.speechSynthesis.resume(); setIsSpeaking(true); }
      else { startSpeakingFrom(currentSentence); }
    }
  };

  const stopSpeaking = () => { window.speechSynthesis.cancel(); setIsSpeaking(false); };
  const nextSentence = () => { if (currentSentence < sentences.length - 1) startSpeakingFrom(currentSentence + 1); };
  const prevSentence = () => { if (currentSentence > 0) startSpeakingFrom(currentSentence - 1); };

  const speakAt = (index: number, opts?: { selectOnly?: boolean }) => {
    if (!sentences.length) return;
    if (opts?.selectOnly) { setCurrentSentence(index); return; }
    startSpeakingFrom(index);
  };

  return (
    <div className="container">
      {/* Header */}
      <div className="header">
        <div>
          <h1 className="title">Accessible PDF Dictation Reader</h1>
          <p className="subtitle">Upload a PDF — it will extract text and read it aloud. Keyboard: Space / ← →</p>
        </div>
        <label className="btn" aria-label="Upload PDF">
          <input type="file" accept="application/pdf" style={{display:"none"}}
                 onChange={(e)=> e.target.files?.[0] && extractTextFromPdf(e.target.files[0])}/>
          Upload PDF
        </label>
      </div>

      {/* Progress + info */}
      <div className="card" style={{marginBottom:16}}>
        <div className="progress" aria-hidden={!sentences.length}><span style={{width:`${progressPct}%`}}/></div>
        <div className="pills">
          <span className="pill"><strong>File:</strong> {pdfName || "—"}</span>
          <span className="pill"><strong>Pages:</strong> {numPages || "—"}</span>
          <span className="pill"><strong>Sentences:</strong> {sentences.length || "—"}</span>
          <span className="pill"><strong>Current:</strong> {sentences[currentSentence]?.page ?? "—"}</span>
          <label className="pill" style={{marginLeft:"auto"}}>
            <input type="checkbox" checked={mathMode} onChange={(e)=>setMathMode(e.target.checked)} />
            Math reading
          </label>
        </div>
      </div>

      <div className="row">
        {/* Left */}
        <div className="card">
          <div className="sticky-controls">
            <div style={{display:"flex", flexWrap:"wrap", gap:10, alignItems:"center"}}>
              <button className="btn" onClick={toggleSpeak} disabled={!sentences.length}>
                {isSpeaking ? "Pause" : "Play"}
              </button>
              <button className="btn secondary" onClick={stopSpeaking} disabled={!sentences.length}>Stop</button>
              <button className="btn ghost" onClick={prevSentence} disabled={!sentences.length}>◀ Prev</button>
              <button className="btn ghost" onClick={nextSentence} disabled={!sentences.length}>Next ▶</button>
              <div className="input" title="Voice" style={{minWidth:220}}>
                <span>Voice</span>
                <select value={selectedVoice} onChange={(e)=>setSelectedVoice(e.target.value)}>
                  <option value="">System Default</option>
                  {voices.map(v => <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>)}
                </select>
              </div>
              <label className="input" style={{minWidth:200}}>
                <span>Volume {volume.toFixed(1)}</span>
                <input type="range" min={0} max={1} step={0.1} value={volume}
                       onChange={(e)=>setVolume(parseFloat(e.target.value))}/>
              </label>
              {isLoading && <span className="pill">Extracting text…</span>}
            </div>
          </div>

          <h3 style={{marginTop:10}}>Reading View</h3>
          <div ref={listRef} className="reading" aria-live="polite">
            {sentences.length ? sentences.map((s,i)=>(
              <p key={i} data-sent-index={i}
                 className={`sent ${i===currentSentence?"active":""}`}
                 role="button" tabIndex={0}
                 title="Click to speak (Ctrl/Cmd+Click to only select)"
                 onClick={(e)=>speakAt(i,{selectOnly:e.ctrlKey||e.metaKey})}
                 onKeyDown={(e)=>{ if(e.key==="Enter"||e.key===" ") { e.preventDefault(); speakAt(i); } }}>
                <span className="badge">p{s.page}</span>{s.text}
              </p>
            )) : <p className="subtitle">Upload a PDF to see the extracted text here.</p>}
          </div>
          {error && <p className="subtitle" style={{color:"#ffb4b4", marginTop:10}}>{error}</p>}
        </div>

        {/* Right */}
        <div className="card">
          <h3 style={{marginTop:0}}>Full Transcript</h3>
          <textarea
            value={fullTranscript}
            readOnly
            style={{
              width:"100%", minHeight:"420px", resize:"vertical",
              background:"#0b152b", color:"var(--text)", border:"1px solid var(--border)",
              borderRadius:12, padding:12
            }}
          />
        </div>
      </div>

      {/* Footer credit */}
      <div className="footer">Made with <span className="heart">♥</span> by <strong>Mehul Uniyal</strong></div>
    </div>
  );
}
