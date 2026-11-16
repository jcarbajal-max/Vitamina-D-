import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ScientificMarkdownProps {
  content: string;
}

export function ScientificMarkdown({ content }: ScientificMarkdownProps) {
  return (
    <div className="scientific-prose break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...props }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              {...props}
            >
              {children}
            </a>
          ),
          table: ({ children, ...props }) => (
            <div className="overflow-x-auto my-3">
              <table {...props}>{children}</table>
            </div>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
