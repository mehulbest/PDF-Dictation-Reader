import { useEffect, useMemo, useRef, useState } from "react";
import "./index.css";

export default function PDFDictationReader() {
  // ------------ UI State ------------
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

  // ------------ Refs ------------
  const listRef = useRef<HTMLDivElement>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const pdfjsRef = useRef<any>(null);

  // ------------ PDF.js Loader (Vite + pdfjs-dist v4) ------------
  const loadPdfJs = async () => {
    if (pdfjsRef.current) return pdfjsRef.current;
    const pdfjs = await import("pdfjs-dist");
    const workerSrc = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    (pdfjs as any).GlobalWorkerOptions.workerSrc = (workerSrc as any).default;
    pdfjsRef.current = pdfjs;
    return pdfjs;
  };

  // ------------ Voices ------------
  useEffect(() => {
    const populate = () => {
      const v = window.speechSynthesis.getVoices();
      setVoices(v);
      const pref = v.find((vv) => /en-/i.test(vv.lang))?.name;
      if (pref) setSelectedVoice(pref);
    };
    populate();
    window.speechSynthesis.onvoiceschanged = populate;
  }, []);

  // ------------ Keyboard Shortcuts ------------
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

  // ------------ Math Normalization ------------
  const looksMathy = (s: string) =>
    /[=+−\-*/×^√(){}[\]|<>≤≥%]|(?:\b(?:sin|cos|tan|log|ln|lim|∫|Σ)\b)/i.test(s);

  const normalizeForSpeech = (s: string) => {
    let t = s;

    // Superscripts first (x², x³, …)
    t = t
      .replace(/([a-zA-Z])²/g, "$1 squared")
      .replace(/([a-zA-Z])³/g, "$1 cubed")
      .replace(/([a-zA-Z])⁴/g, "$1 to the power of 4")
      .replace(/([a-zA-Z])⁵/g, "$1 to the power of 5")
      .replace(/([a-zA-Z])⁶/g, "$1 to the power of 6")
      .replace(/([a-zA-Z])⁷/g, "$1 to the power of 7")
      .replace(/([a-zA-Z])⁸/g, "$1 to the power of 8")
      .replace(/([a-zA-Z])⁹/g, "$1 to the power of 9");

    if (looksMathy(t)) {
      // Caret powers
      t = t
        .replace(/\b([a-zA-Z])\s*\^\s*2\b/g, "$1 squared")
        .replace(/\b([a-zA-Z])\s*\^\s*3\b/g, "$1 cubed")
        .replace(/\b([a-zA-Z])\s*\^\s*(\d+)\b/g, "$1 to the power of $2");

      // OCR-style: "x 2" / "x 3" near math symbols → treat as squared/cubed
      t = t.replace(/([a-zA-Z])\s*(2|3)(?=[^a-zA-Z]|$)/g, (m, v: string, pow: string, offset: number, str: string) => {
        const ctx = str.slice(Math.max(0, offset - 4), offset + 4);
        return /[=+\-×*/(]/.test(ctx) ? (pow === "2" ? `${v} squared` : `${v} cubed`) : m;
      });

      // Function notation: f(t) → f of t
      t = t.replace(/\b([a-zA-Z])\s*\(\s*([a-zA-Z0-9]+)\s*\)/g, "$1 of $2");

      // Operators
      t = t
        .replace(/[•·]/g, " ")
        .replace(/=/g, " equals ")
        .replace(/\+/g, " plus ")
        .replace(/[−–—-]/g, " minus ")
        .replace(/[×*]/g, " times ")
        .replace(/(?<=\w)\/(?=\w)/g, " divided by ");

      // Fractions & roots
      t = t
        .replace(/(\([^)]*\)|\S+)\/(\([^)]*\)|\S+)/g, "($1) over ($2)")
        .replace(/√\(?([^)]+)\)?/g, " square root of $1 ");

      // Trig & logs
      t = t
        .replace(/\bsin\(?([^)]+)?\)?/gi, "sine of $1")
        .replace(/\bcos\(?([^)]+)?\)?/gi, "cosine of $1")
        .replace(/\btan\(?([^)]+)?\)?/gi, "tangent of $1")
        .replace(/\bln\(/gi, " natural log of (")
        .replace(/\blog_?(\d+)?\(/gi, " log base $1 of (");

      // Inequalities, sums, integrals, limits
      t = t
        .replace(/≤/g, " less than or equal to ")
        .replace(/≥/g, " greater than or equal to ")
        .replace(/</g, " less than ")
        .replace(/>/g, " greater than ")
        .replace(/Σ/g, " sum of ")
        .replace(/∫/g, " integral of ")
        .replace(/\blim\b/gi, " limit ");
    }

    return t.replace(/\s{2,}/g, " ").trim();
  };

  // ------------ Sentence Builder ------------
  const buildSentences = (pages: string[]) => {
    const result: { text: string; page: number }[] = [];
    pages.forEach((txt, i) => {
      const cleaned = txt.replace(/\s+/g, " ").replace(/\.(?=\S)/g, ". ").trim();
      const chunks = cleaned
        .split(/(?<=[.!?])\s+(?=[A-Z0-9("\"'\[])/)
        .map((s) => s.trim())
        .filter(Boolean);
      chunks.forEach((c) => result.push({ text: c, page: i + 1 }));
    });
    return result;
  };

  // ------------ Helpers for extraction ------------
  const supers = { "0":"⁰","1":"¹","2":"²","3":"³","4":"⁴","5":"⁵","6":"⁶","7":"⁷","8":"⁸","9":"⁹" } as const;
  const superscriptChar = (n: string) => (supers as any)[n] || n;

  // Re-attach superscripts when split across lines
  const mergeSuperscriptLines = (lines: string[]) => {
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const prev = out[out.length - 1];
      const cur = lines[i].trim();
      const isSupLine = /^(\^?\d)$/.test(cur) || /^[²³⁴⁵⁶⁷⁸⁹]$/.test(cur);
      const prevLooksLikeVarOrGroup = prev && (/[a-zA-Z]\s*$/.test(prev) || /\)\s*$/.test(prev));
      if (isSupLine && prevLooksLikeVarOrGroup) {
        if (/^[²³⁴⁵⁶⁷⁸⁹]$/.test(cur)) out[out.length - 1] = prev + cur;
        else out[out.length - 1] = prev + superscriptChar(cur.replace("^",""));
      } else {
        out.push(lines[i]);
      }
    }
    return out;
  };

// Fix inline artifacts within a line: dashes, fractions (incl. spaced underscores & vulgar fractions),
// powers, and common “missing minus” cases
const fixInlineMathArtifacts = (line: string) => {
  let fixed = line;

  // 0) Normalize dash variants that sometimes disappear in extraction
  // U+2212 (−), en dash (–), em dash (—) -> hyphen-minus (-)
  fixed = fixed.replace(/[−–—]/g, "-");

  // 1) Normalize Unicode vulgar fractions to ASCII "a/b"
  const vulgarMap: Record<string, string> = {
    "¼": "1/4", "½": "1/2", "¾": "3/4",
    "⅓": "1/3", "⅔": "2/3",
    "⅕": "1/5", "⅖": "2/5", "⅗": "3/5", "⅘": "4/5",
    "⅙": "1/6", "⅚": "5/6",
    "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8",
  };
  fixed = fixed.replace(/[¼½¾⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/g, m => vulgarMap[m] || m);

  // 2) Rebuild fractions drawn as separate glyphs
  //    - "1 / 4" or "1/ 4" or "1 /4" -> "1/4"
  fixed = fixed.replace(/(\d+)\s*\/\s*(\d+)/g, "$1/$2");
  //    - "1__4" -> "1/4"
  fixed = fixed.replace(/(\d+)_+(\d+)/g, "$1/$2");
  //    - "1 _ _ 4" or "1 _   _  4" (underscores with spaces between) -> "1/4"
  fixed = fixed.replace(/(\d+)(?:\s*_+\s*)+(\d+)/g, "$1/$2");

  // 3) Merge powers when caret/digit are split: "x ^ 2" -> "x²"
  fixed = fixed.replace(/([a-zA-Z])\s*\^\s*([0-9])\b/g, (m, v: string, pow: string) => {
    const map: Record<string,string> = { "0":"⁰","1":"¹","2":"²","3":"³","4":"⁴","5":"⁵","6":"⁶","7":"⁷","8":"⁸","9":"⁹" };
    return v + (map[pow] || pow);
  });

  // 4) (… ) 2  -> (… )²   e.g., ( - 3 ) 2 -> ( - 3 )²
  fixed = fixed.replace(/(\([^)]+\))\s*([0-9])\b/g, (m, base: string, pow: string) => {
    const map: Record<string,string> = { "0":"⁰","1":"¹","2":"²","3":"³","4":"⁴","5":"⁵","6":"⁶","7":"⁷","8":"⁸","9":"⁹" };
    return base + (map[pow] || pow);
  });

  // 5) Inverse trig where the superscript minus gets dropped: "sin ¹(x)" -> "sin⁻¹(x)"
  fixed = fixed.replace(/\b(sin|cos|tan)\s*¹\s*\(/gi, (m, fn) => `${fn}⁻¹(`);

  // 6) Heuristics to restore missing minus in common patterns
  //    (2x  5) -> (2x - 5), (x  1) -> (x - 1), |x  4| -> |x - 4|
  fixed = fixed.replace(/\(([^)]*?\d[a-z]*)\s+(\d+)\)/g, "($1 - $2)");
  fixed = fixed.replace(/\(([^)]*?[a-zA-Z])\s+(\d+)\)/g, "($1 - $2)");
  fixed = fixed.replace(/\|x\s+(\d+)\|/g, (_m, d) => `|x - ${d}|`);
  //    32 t  16 t² -> 32 t - 16 t²
  fixed = fixed.replace(/(\d+)\s*([a-zA-Z])\s+(\d+)\s*([a-zA-Z])/g, "$1 $2 - $3 $4");
  //    x  1) -> x - 1)
  fixed = fixed.replace(/([a-zA-Z])\s+(\d+)\)/g, "$1 - $2)");

  return fixed;
};



  // ------------ PDF Text Extraction (robust, header/footer cleanup) ------------
  const extractTextFromPdf = async (file: File) => {
    setIsLoading(true);
    setError(null);
    setPdfName(file.name);
    setCurrentSentence(0);

    try {
      const arrayBuf = await file.arrayBuffer();
      const pdfjs = await loadPdfJs();
      const pdf = await (pdfjs as any).getDocument({ data: arrayBuf }).promise;
      setNumPages(pdf.numPages);

      // 1) Build lines per page (group items by Y; looser threshold to avoid splitting superscripts)
      const pagesRawLines: string[][] = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        const items = content.items as any[];

        let currentY: number | null = null;
        let buff: string[] = [];
        const lines: { y: number; text: string }[] = [];

        const flush = () => {
          if (buff.length) {
            const raw = buff.join(" ").replace(/\s{2,}/g, " ").trim();
            const fixed = fixInlineMathArtifacts(raw);
            if (fixed) lines.push({ y: (currentY as number), text: fixed });
            buff = [];
          }
        };

        for (const it of items) {
          const str: string = it.str ?? "";
          const tr = it.transform || it?.transformMatrix || [1, 0, 0, 1, 0, 0];
          const y = tr[5]; // baseline Y

          const newLine = Math.abs(y - (currentY ?? y)) > 3.5; // tolerant drift
          if (newLine) { flush(); currentY = y; }
          else if (currentY === null) currentY = y;

          buff.push(str);
        }
        flush();

        // Merge obvious superscript-only next lines back into previous
        const merged = mergeSuperscriptLines(lines.map((l) => l.text).filter(Boolean));
        pagesRawLines.push(merged);
      }

      // 2) Detect lines that repeat on many pages (headers/footers)
      const freq = new Map<string, number>();
      pagesRawLines.forEach((page) =>
        page.forEach((line) => freq.set(line, (freq.get(line) || 0) + 1))
      );
      const chrome = new Set(
        [...freq.entries()]
          .filter(([, n]) => n >= Math.max(2, Math.floor(pdf.numPages * 0.5)))
          .map(([line]) => line)
      );

      // 3) Regex filters for page junk
      const junkRegexes = [
        /(^|\s)Page\s*\d+(\s*of\s*\d+)?/i,     // Page 8 / Page 8 of 10
        /Unit\s*\d+_Book_\d+\.indb/i,          // InDesign footer file
        /~\/|[A-Z]:\\|desktop/i,               // file paths
        /^\d{2,}\s*$/,                         // lone big numbers (keep single digits for powers)
        /^\d+\s+Algebra\s*1\s*•\s*Unit\s*\d+/i // "8 Algebra 1 • Unit 7 …" header line
      ];

      // 4) Build cleaned text per page
      const cleanedPages: string[] = pagesRawLines.map((lines) => {
        const kept = lines.filter(
          (line) => !chrome.has(line) && !junkRegexes.some((rx) => rx.test(line))
        );
        return kept.join("\n");
      });

      setTextByPage(cleanedPages);
      setSentences(buildSentences(cleanedPages));
    } catch (e) {
      console.error(e);
      setError("Failed to read PDF. Please try a different file.");
    } finally {
      setIsLoading(false);
    }
  };

  // ------------ TTS ------------
  const buildUtterance = (text: string) => {
    const u = new SpeechSynthesisUtterance(text);
    const v = voices.find((vv) => vv.name === selectedVoice);
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
    if (opts?.selectOnly) {
      setCurrentSentence(index);
      const el = listRef.current?.querySelector(`[data-sent-index="${index}"]`) as HTMLElement | null;
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    startSpeakingFrom(index);
  };

  // ------------ UI ------------
  return (
    <div className="container">
      {/* Header */}
      <div className="header">
        <div>
          <h1 className="title">Accessible PDF Dictation Reader</h1>
        </div>
        <label className="btn" aria-label="Upload PDF">
          <input
            type="file"
            accept="application/pdf"
            style={{ display: "none" }}
            onChange={(e) => e.target.files?.[0] && extractTextFromPdf(e.target.files[0])}
          />
          Upload PDF
        </label>
      </div>

      {/* Progress + info */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="progress" aria-hidden={!sentences.length}>
          <span style={{ width: `${progressPct}%` }} />
        </div>
        <div className="pills">
          <span className="pill"><strong>File:</strong> {pdfName || "—"}</span>
          <span className="pill"><strong>Pages:</strong> {numPages || "—"}</span>
          <span className="pill"><strong>Sentences:</strong> {sentences.length || "—"}</span>
          <span className="pill"><strong>Current:</strong> {sentences[currentSentence]?.page ?? "—"}</span>
          <label className="pill" style={{ marginLeft: "auto" }}>
            <input type="checkbox" checked={mathMode} onChange={(e) => setMathMode(e.target.checked)} />
            Math reading
          </label>
        </div>
      </div>

      <div className="row">
        {/* Left: controls + reading view */}
        <div className="card">
          <div className="sticky-controls">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
              <button className="btn" onClick={toggleSpeak} disabled={!sentences.length}>
                {isSpeaking ? "Pause" : "Play"}
              </button>
              <button className="btn secondary" onClick={stopSpeaking} disabled={!sentences.length}>Stop</button>
              <button className="btn ghost" onClick={prevSentence} disabled={!sentences.length}>◀ Prev</button>
              <button className="btn ghost" onClick={nextSentence} disabled={!sentences.length}>Next ▶</button>

              <div className="input" title="Voice" style={{ minWidth: 220 }}>
                <span>Voice</span>
                <select value={selectedVoice} onChange={(e) => setSelectedVoice(e.target.value)}>
                  <option value="">System Default</option>
                  {voices.map((v) => (
                    <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>
                  ))}
                </select>
              </div>

              <label className="input" style={{ minWidth: 200 }}>
                <span>Volume {volume.toFixed(1)}</span>
                <input type="range" min={0} max={1} step={0.1} value={volume} onChange={(e) => setVolume(parseFloat(e.target.value))}/>
              </label>

              {isLoading && <span className="pill">Extracting text…</span>}
            </div>
          </div>

          <h3 style={{ marginTop: 10 }}>Reading View</h3>
          <div ref={listRef} className="reading" aria-live="polite">
            {sentences.length ? (
              sentences.map((s, i) => (
                <p
                  key={i}
                  data-sent-index={i}
                  className={`sent ${i === currentSentence ? "active" : ""}`}
                  role="button"
                  tabIndex={0}
                  title="Click to speak (Ctrl/Cmd+Click to only select)"
                  onClick={(e) => speakAt(i, { selectOnly: e.ctrlKey || e.metaKey })}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); speakAt(i); } }}
                >
                  <span className="badge">p{s.page}</span>
                  {s.text}
                </p>
              ))
            ) : (
              <p className="subtitle">Upload a PDF to see the extracted text here.</p>
            )}
          </div>

          {error && <p className="subtitle" style={{ color: "#ffb4b4", marginTop: 10 }}>{error}</p>}
        </div>

        {/* Right: transcript */}
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Full Transcript</h3>
          <textarea
            value={fullTranscript}
            readOnly
            style={{
              width: "100%",
              minHeight: "420px",
              resize: "vertical",
              background: "#0b152b",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: 12
            }}
          />
        </div>
      </div>

      {/* Footer credit */}
      <div className="footer">Made with <span className="heart">♥</span> by <strong>Mehul Uniyal</strong></div>
    </div>
  );
}
