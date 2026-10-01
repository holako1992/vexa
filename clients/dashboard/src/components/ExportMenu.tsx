"use client";
/** The transcript's Export dialog: one button per format, plus copy as Markdown.
 *
 *  Every file is built in the browser from the lines the page is showing (`lib/export.ts`), so
 *  what downloads is exactly what is on screen — speaker names included — with no second fetch
 *  and no server-side renderer holding the user's transcript. PDF is the browser's own print
 *  dialog over the page's print stylesheet ("Save as PDF"), which renders every script and
 *  language the page itself can.
 */
import { useState } from "react";
import { Download, FileText, Printer } from "lucide-react";
import {
  EXPORT_MIME,
  type ExportFact,
  type ExportFormat,
  exportFileName,
  transcriptToDocx,
  transcriptToMarkdown,
  transcriptToSrt,
  transcriptToVtt,
} from "@/lib/export";
import { transcriptToText, type TranscriptLine } from "@/lib/meetings";
import { Button, Dialog, useToast } from "./ui";

const FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: "txt", label: "Plain text", hint: ".txt — one line per segment" },
  { id: "md", label: "Markdown", hint: ".md — for notes apps and wikis" },
  { id: "docx", label: "Word", hint: ".docx — opens in Word, Pages and Google Docs" },
  { id: "srt", label: "SubRip subtitles", hint: ".srt — timed captions for video players" },
  { id: "vtt", label: "WebVTT subtitles", hint: ".vtt — timed captions for the web" },
];

function build(format: ExportFormat, title: string, facts: readonly ExportFact[], lines: readonly TranscriptLine[]): BlobPart {
  switch (format) {
    case "txt":
      return transcriptToText(title, lines);
    case "md":
      return transcriptToMarkdown(title, facts, lines);
    case "srt":
      return transcriptToSrt(lines);
    case "vtt":
      return transcriptToVtt(lines);
    case "docx":
      return transcriptToDocx(title, facts, lines) as Uint8Array<ArrayBuffer>;
  }
}

function save(name: string, type: string, data: BlobPart) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function ExportMenu({
  title,
  facts,
  lines,
}: {
  title: string;
  facts: readonly ExportFact[];
  lines: readonly TranscriptLine[];
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);

  function download(format: ExportFormat) {
    save(exportFileName(title, format), EXPORT_MIME[format], build(format, title, facts, lines));
    setOpen(false);
  }

  async function copyMarkdown() {
    try {
      await navigator.clipboard.writeText(transcriptToMarkdown(title, facts, lines));
      toast.push({ tone: "success", title: "Copied as Markdown." });
      setOpen(false);
    } catch (e) {
      console.warn("clipboard write failed", e);
      toast.push({ tone: "error", title: "Couldn't copy to the clipboard." });
    }
  }

  function printPdf() {
    setOpen(false);
    // After the dialog has unmounted, so it is not part of the printed page.
    setTimeout(() => window.print(), 0);
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} disabled={!lines.length} icon={<Download size={15} aria-hidden />}>
        Export
      </Button>
      {open && (
        <Dialog open onClose={() => setOpen(false)} title="Export transcript" icon={<Download size={16} aria-hidden />}>
          <div className="flex flex-col gap-1 p-4 pt-2">
            {FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => download(f.id)}
                className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-raised"
              >
                <FileText size={16} aria-hidden className="shrink-0 text-ink-3" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{f.label}</span>
                  <span className="block text-xs text-ink-3">{f.hint}</span>
                </span>
              </button>
            ))}
            <button
              type="button"
              onClick={printPdf}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-raised"
            >
              <Printer size={16} aria-hidden className="shrink-0 text-ink-3" />
              <span className="min-w-0">
                <span className="block text-sm font-medium">PDF</span>
                <span className="block text-xs text-ink-3">Opens the print dialog — choose &ldquo;Save as PDF&rdquo;</span>
              </span>
            </button>
            <div className="mt-2 border-t border-line pt-3">
              <Button variant="ghost" onClick={() => void copyMarkdown()} className="w-full justify-start">
                Copy as Markdown
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
