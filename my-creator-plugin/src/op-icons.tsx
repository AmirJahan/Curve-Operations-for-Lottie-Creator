/** Pathfinder-style glyphs. Two 12x12 squares at (3,3) and (9,9) in a 24 viewBox. */

const OUTLINE = 'M3 3h12v12H3z';
const FRONT = 'M9 9h12v12H9z';
const UNION_PATH = 'M3 3h12v6h6v12H9v-6H3z';
const OVERLAP = 'M9 9h6v6H9z';

interface IconProps {
  className?: string;
}

const base = {
  width: 24,
  height: 24,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinejoin: 'round' as const,
};

export const UnionIcon = ({ className }: IconProps) => (
  <svg {...base} className={className} aria-hidden="true">
    <path d={UNION_PATH} fill="currentColor" fillOpacity={0.9} stroke="none" />
  </svg>
);

export const IntersectIcon = ({ className }: IconProps) => (
  <svg {...base} className={className} aria-hidden="true">
    <path d={OUTLINE} opacity={0.45} />
    <path d={FRONT} opacity={0.45} />
    <path d={OVERLAP} fill="currentColor" fillOpacity={0.9} stroke="none" />
  </svg>
);

export const SubtractIcon = ({ className }: IconProps) => (
  <svg {...base} className={className} aria-hidden="true">
    <path d={FRONT} opacity={0.45} />
    <path d="M3 3h12v6H9v6H3z" fill="currentColor" fillOpacity={0.9} stroke="none" />
  </svg>
);

export const ExcludeIcon = ({ className }: IconProps) => (
  <svg {...base} className={className} aria-hidden="true">
    <path
      d={`${UNION_PATH} ${OVERLAP}`}
      fill="currentColor"
      fillOpacity={0.9}
      fillRule="evenodd"
      stroke="none"
    />
  </svg>
);

export const BlendIcon = ({ className }: IconProps) => (
  <svg {...base} className={className} aria-hidden="true">
    <g fill="currentColor" fillOpacity={0.9} stroke="none">
      <circle cx={6.4} cy={12} r={4.6} />
      <circle cx={17.6} cy={12} r={4.6} />
      <path d="M6.4 7.5C10 8.6 14 8.6 17.6 7.5v9C14 15.4 10 15.4 6.4 16.5z" />
    </g>
  </svg>
);
