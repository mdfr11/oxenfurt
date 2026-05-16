import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'

interface MarkdownProps {
  children: string
  className?: string
  /** Inline mode — collapses paragraphs into a single line. Useful for short
   *  one-line strings (e.g. source_quote) where we still want bold/italic
   *  parsing but no block elements. */
  inline?: boolean
}

const blockComponents: Components = {
  p: ({ children }) => (
    <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>
  ),
  strong: ({ children }) => (
    <strong className="font-bold text-app-text">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ children }) => (
    <code className="bg-app-surface border border-app-border px-1.5 py-0.5 rounded text-[0.9em] font-mono">
      {children}
    </code>
  ),
  ul: ({ children }) => (
    <ul className="list-disc list-outside ml-5 space-y-1 my-2 last:mb-0">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal list-outside ml-5 space-y-1 my-2 last:mb-0">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-app-border pl-3 my-2 text-app-hint italic last:mb-0">
      {children}
    </blockquote>
  ),
  h1: ({ children }) => (
    <h3 className="font-bold text-lg mb-2 mt-3 first:mt-0">{children}</h3>
  ),
  h2: ({ children }) => (
    <h4 className="font-bold text-base mb-2 mt-3 first:mt-0">{children}</h4>
  ),
  h3: ({ children }) => (
    <h5 className="font-semibold text-sm mb-1.5 mt-2 first:mt-0">{children}</h5>
  ),
  // Disable hyperlinks — irrelevant in this context and one less attack surface.
  a: ({ children }) => <span>{children}</span>,
  // No images / iframes either; markdown might smuggle them through.
  img: () => null,
  hr: () => <hr className="border-app-border my-3" />,
}

// Inline mode reuses the same inline-level components but collapses block
// elements to plain spans so the result fits on one line.
const inlineComponents: Components = {
  ...blockComponents,
  p: ({ children }) => <>{children}</>,
  ul: ({ children }) => <>{children}</>,
  ol: ({ children }) => <>{children}</>,
  li: ({ children }) => <span>{children} </span>,
  blockquote: ({ children }) => <span className="italic text-app-hint">{children}</span>,
}

export function Markdown({ children, className, inline }: MarkdownProps) {
  const text = children.trim()
  if (text.length === 0) return null
  return (
    <div className={className}>
      <ReactMarkdown
        components={inline ? inlineComponents : blockComponents}
        disallowedElements={['script', 'iframe', 'style']}
        skipHtml
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
