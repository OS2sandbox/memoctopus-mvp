const SKELETON_ROWS = 6;

function SkeletonRow({ widths }: { widths: [string, string] }) {
  return (
    <div className="flex items-center gap-4 px-5 py-4">
      <div className="flex-1 min-w-0">
        <div
          className="rounded animate-pulse"
          style={{ height: 14, width: widths[0], background: 'var(--surface-2)' }}
        />
        <div
          className="mt-2 rounded animate-pulse"
          style={{ height: 11, width: widths[1], background: 'var(--surface-2)' }}
        />
      </div>
      <div
        className="rounded-full animate-pulse flex-shrink-0"
        style={{ height: 20, width: 64, background: 'var(--surface-2)' }}
      />
    </div>
  );
}

const rowWidths: [string, string][] = [
  ['55%', '38%'],
  ['72%', '44%'],
  ['48%', '32%'],
  ['63%', '50%'],
  ['40%', '36%'],
  ['58%', '42%'],
];

export default function ArkivLoading() {
  return (
    <div className="mx-auto max-w-[1040px] px-6 py-12">
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1
            style={{
              fontSize: 'var(--t-h1)',
              fontWeight: 300,
              color: 'var(--ink)',
              margin: 0,
              lineHeight: 1.2,
            }}
          >
            Arkiv
          </h1>
          <div
            className="mt-2 rounded animate-pulse"
            style={{ height: 12, width: 64, background: 'var(--surface-2)' }}
          />
        </div>
      </div>

      <div
        className="border border-[var(--line)] rounded-[var(--radius)] bg-[var(--surface)] divide-y divide-[var(--line)]"
      >
        {rowWidths.slice(0, SKELETON_ROWS).map((widths, i) => (
          <SkeletonRow key={i} widths={widths} />
        ))}
      </div>
    </div>
  );
}
