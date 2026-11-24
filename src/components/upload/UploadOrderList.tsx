'use client';

import React, { useEffect, useState } from 'react';
import { formatDuration, formatFileSize } from '@/lib/utils';

// Rows are keyed by File identity rather than position, so a moved file keeps its
// row: its length is not read again, and keyboard focus stays on the button that
// moved it.
const rowKeys = new WeakMap<File, number>();
let nextRowKey = 0;
function rowKey(file: File): number {
  let key = rowKeys.get(file);
  if (key === undefined) {
    key = nextRowKey++;
    rowKeys.set(file, key);
  }
  return key;
}

/** The file's length in seconds once the browser has read it, else null. */
function useAudioDuration(file: File): number | null {
  const [duration, setDuration] = useState<number | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    let revoked = false;
    const revoke = () => { if (!revoked) { revoked = true; URL.revokeObjectURL(url); } };
    audio.onloadedmetadata = () => { setDuration(audio.duration); revoke(); };
    audio.onerror = () => revoke();
    audio.src = url;
    return () => {
      audio.onloadedmetadata = null;
      revoke();
    };
  }, [file]);
  return duration;
}

const iconButton: React.CSSProperties = {
  width: 30, height: 30, borderRadius: 'var(--radius)',
  border: '1px solid var(--line-2)', background: 'var(--surface)',
  color: 'var(--ink-2)', fontFamily: 'var(--mono)', fontSize: 13,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
};

function OrderRow({ file, position, count, onMove, onRemove }: {
  file: File;
  position: number;
  count: number;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const duration = useAudioDuration(file);
  const buttons: { label: string; text: string; disabled: boolean; onClick: () => void }[] = [
    { label: `Flyt ${file.name} op`, text: '↑', disabled: position === 0, onClick: () => onMove(-1) },
    { label: `Flyt ${file.name} ned`, text: '↓', disabled: position === count - 1, onClick: () => onMove(1) },
    { label: `Fjern ${file.name}`, text: '×', disabled: count === 1, onClick: onRemove },
  ];
  return (
    <li style={{
      display: 'grid', gridTemplateColumns: '28px 1fr auto auto auto', alignItems: 'center', gap: 14,
      padding: '12px 16px', borderTop: position === 0 ? 'none' : '1px solid var(--line)',
      fontFamily: 'var(--mono)', fontSize: 12.5,
    }}>
      <span style={{ color: 'var(--muted-2)', fontVariantNumeric: 'tabular-nums' }}>
        {String(position + 1).padStart(2, '0')}
      </span>
      <span style={{ color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {file.name}
      </span>
      <span style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
        {duration === null ? '…' : formatDuration(duration)}
      </span>
      <span style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{formatFileSize(file.size)}</span>
      <span style={{ display: 'flex', gap: 6 }}>
        {buttons.map((b) => (
          <button
            key={b.label}
            type="button"
            aria-label={b.label}
            title={b.label}
            disabled={b.disabled}
            onClick={b.onClick}
            style={{ ...iconButton, cursor: b.disabled ? 'default' : 'pointer', opacity: b.disabled ? 0.4 : 1 }}
          >
            {b.text}
          </button>
        ))}
      </span>
    </li>
  );
}

interface Props {
  files: File[];
  onChange: (files: File[]) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The step between picking several audio files and transcribing them: the files
 * are one meeting recorded in parts, joined in the order shown here.
 */
export function UploadOrderList({ files, onChange, onConfirm, onCancel }: Props) {
  function move(from: number, by: -1 | 1) {
    const next = [...files];
    [next[from], next[from + by]] = [next[from + by], next[from]];
    onChange(next);
  }

  return (
    <div style={{ minHeight: 'calc(100vh - 56px)', padding: '48px 48px 96px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4 }}>
          {files.length} lydfiler · vælg rækkefølgen
        </div>
        <p style={{ margin: '10px 0 0', fontSize: 22, fontWeight: 300, color: 'var(--ink)', lineHeight: 1.45 }}>
          Filerne samles til én optagelse i rækkefølgen herunder.
        </p>

        <ol style={{
          margin: '26px 0 0', padding: 0, listStyle: 'none',
          border: '1px solid var(--line-2)', borderRadius: 'var(--radius)', background: 'var(--surface)',
        }}>
          {files.map((file, i) => (
            <OrderRow
              key={rowKey(file)}
              file={file}
              position={i}
              count={files.length}
              onMove={(by) => move(i, by)}
              onRemove={() => onChange(files.filter((_, j) => j !== i))}
            />
          ))}
        </ol>

        <div style={{
          marginTop: 36, paddingTop: 22, borderTop: '1px solid var(--line)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              fontFamily: 'var(--mono)', fontSize: 12, padding: '7px 14px', borderRadius: 'var(--radius)',
              border: '1px solid var(--line-2)', background: 'var(--surface)', color: 'var(--ink-2)', cursor: 'pointer',
            }}
          >
            annullér
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{
              fontFamily: 'var(--mono)', fontSize: 13, padding: '10px 18px', borderRadius: 'var(--radius)',
              border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer',
            }}
          >
            saml og transskribér →
          </button>
        </div>
      </div>
    </div>
  );
}
