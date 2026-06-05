const ORBIT_NODES: [number, number][] = [
  [16, 7], [22.36, 9.64], [25, 16], [22.36, 22.36],
  [16, 25], [9.64, 22.36], [7, 16], [9.64, 9.64],
];
const DOT_NODES = ORBIT_NODES.slice(1);

export function LogoMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden style={{ display: 'block', flexShrink: 0 }}>
      <rect width="32" height="32" rx="7" fill="#1535EB" />
      <circle cx="16" cy="16" r="5" fill="none" stroke="#fff" strokeWidth="3" />
      {ORBIT_NODES.map(([x, y], i) => (
        <circle key={`o${i}`} cx={x} cy={y} r="2.2" fill="#1535EB" />
      ))}
      <circle cx="16" cy="7" r="1.5" fill="#E8304A" />
      {DOT_NODES.map(([x, y], i) => (
        <circle key={`d${i}`} cx={x} cy={y} r="1.5" fill="#fff" />
      ))}
    </svg>
  );
}
