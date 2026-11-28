import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';

function renderInlineMarkdown(text: string, depth = 0): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const tokenRegex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let keyIdx = 0;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(text.slice(lastIdx, match.index));
    }
    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(
        <code
          key={keyIdx++}
          className="rounded bg-black/45 px-1 py-0.5 font-mono text-[11px] text-amber-200"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      const inner = token.slice(2, -2);
      parts.push(
        <strong key={keyIdx++} className="font-semibold text-white">
          {depth < 2 ? renderInlineMarkdown(inner, depth + 1) : inner}
        </strong>
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      const inner = token.slice(1, -1);
      parts.push(
        <em key={keyIdx++} className="italic text-sky-200">
          {depth < 2 ? renderInlineMarkdown(inner, depth + 1) : inner}
        </em>
      );
    }
    lastIdx = match.index + token.length;
  }

  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx));
  }
  return parts;
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div className="my-1.5 overflow-hidden rounded-lg border border-white/10 bg-[#0b0d12]">
      <div className="flex items-center justify-between border-b border-white/[0.06] bg-white/[0.03] px-2.5 py-1 text-[10px] text-slate-300">
        <span className="font-mono uppercase">Snippet</span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          aria-label="Sao chép đoạn mã"
          className="inline-flex min-h-[24px] items-center gap-1 rounded px-1.5 text-[10px] text-slate-300 hover:bg-white/10 hover:text-white"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          <span>{copied ? 'Đã copy' : 'Copy'}</span>
        </button>
      </div>
      <pre className="overflow-x-auto p-2.5 font-mono text-[11px] leading-relaxed text-amber-100">
        {code}
      </pre>
    </div>
  );
}

export default function CoachMarkdown({ content }: { content: string }) {
  const lines = content.split(/\r?\n/);
  const nodes: React.ReactNode[] = [];
  let idx = 0;

  while (idx < lines.length) {
    const line = lines[idx];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      const codeLines: string[] = [];
      idx++;
      while (idx < lines.length && !lines[idx].trim().startsWith('```')) {
        codeLines.push(lines[idx]);
        idx++;
      }
      nodes.push(<CodeBlock key={`cb-${idx}`} code={codeLines.join('\n')} />);
      idx++;
      continue;
    }

    if (!trimmed) {
      idx++;
      continue;
    }

    if (trimmed.startsWith('### ') || trimmed.startsWith('## ') || trimmed.startsWith('# ')) {
      const headingText = trimmed.replace(/^#{1,3}\s+/, '');
      nodes.push(
        <h4
          key={`h-${idx}`}
          className="mt-1.5 border-b border-white/[0.08] pb-1 font-display text-[12px] font-bold text-amber-300 first:mt-0"
        >
          {renderInlineMarkdown(headingText)}
        </h4>
      );
      idx++;
      continue;
    }

    if (/^[-*•]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (idx < lines.length && /^[-*•]\s+/.test(lines[idx].trim())) {
        items.push(lines[idx].trim().replace(/^[-*•]\s+/, ''));
        idx++;
      }
      nodes.push(
        <ul key={`ul-${idx}`} className="my-1 space-y-1 pl-3.5 text-[12px] leading-relaxed text-slate-200">
          {items.map((item, itemIdx) => (
            <li key={itemIdx} className="list-disc marker:text-amber-400">
              {renderInlineMarkdown(item)}
            </li>
          ))}
        </ul>
      );
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (idx < lines.length && /^\d+\.\s+/.test(lines[idx].trim())) {
        items.push(lines[idx].trim().replace(/^\d+\.\s+/, ''));
        idx++;
      }
      nodes.push(
        <ol key={`ol-${idx}`} className="my-1 space-y-1 pl-4 text-[12px] leading-relaxed text-slate-200">
          {items.map((item, itemIdx) => (
            <li key={itemIdx} className="list-decimal marker:font-semibold marker:text-sky-300">
              {renderInlineMarkdown(item)}
            </li>
          ))}
        </ol>
      );
      continue;
    }

    nodes.push(
      <p key={`p-${idx}`} className="my-1 whitespace-pre-wrap text-[12px] leading-relaxed text-slate-200 first:mt-0">
        {renderInlineMarkdown(line)}
      </p>
    );
    idx++;
  }

  return <div className="space-y-0.5">{nodes}</div>;
}
