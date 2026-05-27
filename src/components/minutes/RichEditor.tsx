'use client';

import React, { useEffect, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';

interface RichEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
}

function ToolbarBtn({
  onPress,
  active,
  title,
  children,
}: {
  onPress: () => void;
  active?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        e.preventDefault();
        onPress();
      }}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderRadius: 'var(--radius-sm, 4px)',
        border: 'none',
        background: active ? 'var(--line)' : 'transparent',
        color: active ? 'var(--ink)' : 'var(--ink-3)',
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: 600,
        transition: 'background 0.1s',
      }}
    >
      {children}
    </button>
  );
}

const SEP = (
  <div style={{ width: 1, height: 16, background: 'var(--line)', margin: '0 4px', flexShrink: 0 }} />
);

export function RichEditor({ value, onChange, placeholder }: RichEditorProps) {
  const [focused, setFocused] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        codeBlock: false,
        code: false,
        blockquote: false,
        horizontalRule: false,
      }),
      Markdown.configure({
        html: false,
        transformCopiedText: true,
        transformPastedText: true,
      }),
    ],
    content: value,
    editorProps: {
      attributes: { style: 'outline:none;min-height:80px' },
    },
    onUpdate({ editor }) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onChange((editor.storage as any).markdown.getMarkdown());
    },
    onFocus() { setFocused(true); },
    onBlur() { setFocused(false); },
    immediatelyRender: false,
  });

  // Sync external value changes (e.g. version restore)
  useEffect(() => {
    if (!editor) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const current = (editor.storage as any).markdown.getMarkdown();
    if (current !== value) {
      editor.commands.setContent(value);
    }
  }, [value, editor]);

  if (!editor) return null;

  return (
    <div
      style={{
        border: `1px solid ${focused ? 'var(--accent)' : 'var(--line)'}`,
        borderRadius: 'var(--radius)',
        background: 'var(--surface)',
        transition: 'border-color 0.15s',
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: '4px 8px',
          borderBottom: '1px solid var(--line)',
          flexWrap: 'wrap',
        }}
      >
        <ToolbarBtn
          onPress={() => editor.chain().focus().toggleBold().run()}
          active={editor.isActive('bold')}
          title="Fed (Ctrl+B)"
        >
          B
        </ToolbarBtn>
        <ToolbarBtn
          onPress={() => editor.chain().focus().toggleItalic().run()}
          active={editor.isActive('italic')}
          title="Kursiv (Ctrl+I)"
        >
          <em style={{ fontStyle: 'italic' }}>I</em>
        </ToolbarBtn>
        {SEP}
        <ToolbarBtn
          onPress={() => editor.chain().focus().toggleBulletList().run()}
          active={editor.isActive('bulletList')}
          title="Punktliste"
        >
          ☰
        </ToolbarBtn>
        <ToolbarBtn
          onPress={() => editor.chain().focus().toggleOrderedList().run()}
          active={editor.isActive('orderedList')}
          title="Nummereret liste"
        >
          <span style={{ fontFamily: 'monospace', fontSize: 11 }}>1.</span>
        </ToolbarBtn>
        {SEP}
        <ToolbarBtn
          onPress={() => editor.chain().focus().undo().run()}
          title="Fortryd (Ctrl+Z)"
        >
          ↩
        </ToolbarBtn>
        <ToolbarBtn
          onPress={() => editor.chain().focus().redo().run()}
          title="Gentag (Ctrl+Y)"
        >
          ↪
        </ToolbarBtn>
      </div>

      {/* Content area */}
      <div
        style={{
          padding: '10px 12px',
          fontSize: 'var(--t-body)',
          lineHeight: 1.7,
          color: 'var(--ink)',
          cursor: 'text',
        }}
        onClick={() => editor.commands.focus()}
      >
        {editor.isEmpty && placeholder && (
          <div
            style={{
              position: 'absolute',
              pointerEvents: 'none',
              color: 'var(--muted-2)',
              fontSize: 'var(--t-body)',
            }}
          >
            {placeholder}
          </div>
        )}
        <EditorContent editor={editor} />
      </div>

      <style>{`
        .ProseMirror { outline: none; }
        .ProseMirror p { margin: 0 0 0.5em; }
        .ProseMirror p:last-child { margin-bottom: 0; }
        .ProseMirror ul,
        .ProseMirror ol { margin: 0 0 0.5em; padding-left: 1.4em; }
        .ProseMirror ul { list-style: disc; }
        .ProseMirror ol { list-style: decimal; }
        .ProseMirror li { margin-bottom: 0.15em; line-height: 1.7; }
        .ProseMirror li > p { margin: 0; }
        .ProseMirror h2,
        .ProseMirror h3 { font-size: 1em; font-weight: 600; margin: 0.5em 0 0.2em; }
        .ProseMirror strong { font-weight: 600; }
      `}</style>
    </div>
  );
}
