export default function Loading() {
  return (
    <div className="mx-auto max-w-[1040px] px-6 py-12">
      <div className="flex items-center gap-3 text-[var(--muted)]" style={{ fontSize: 'var(--t-small)' }}>
        <span
          style={{
            width: 16,
            height: 16,
            borderRadius: '50%',
            border: '2px solid var(--line)',
            borderTopColor: 'var(--accent)',
            display: 'inline-block',
            animation: 'spin 0.7s linear infinite',
          }}
        />
        Indlæser referat…
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
