import { useMemo } from 'react'
import { encode } from 'uqr'

/** A QR code drawn as one SVG path, black on white whatever the theme (scanners need contrast). */
export function Qr({ text, size = 200, label }: { text: string; size?: number; label: string }) {
  const { path, n } = useMemo(() => {
    const qr = encode(text, { ecc: 'M', border: 0 })
    let d = ''
    qr.data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) d += `M${x + 4} ${y + 4}h1v1h-1z`
      }),
    )
    return { path: d, n: qr.size + 8 }
  }, [text])
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${n} ${n}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}
