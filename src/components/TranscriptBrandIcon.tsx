/** Icono único de transcripción: documento + líneas (trazo grueso, legible en cristal). */

interface TranscriptBrandIconProps {
  className?: string;
  /** Tamaño en px (ancho y alto). */
  size?: number;
}

export function TranscriptBrandIcon({ className, size = 24 }: TranscriptBrandIconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M8 3.25h5.35L18.75 8.65v10.6A1.9 1.9 0 0 1 16.85 21.15H8a1.9 1.9 0 0 1-1.9-1.9V5.15A1.9 1.9 0 0 1 8 3.25Z"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinejoin="round"
      />
      <path d="M13.35 3.25v5.4h5.4" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.65 11.85h6.7M8.65 14.35h5.4M8.65 16.85h6.7" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
    </svg>
  );
}
