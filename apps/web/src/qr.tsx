import { encode } from 'uqr'

/** QR code as plain SVG elements (no innerHTML), e.g. for the otpauth:// URI. */
export function QrCode({
  value,
  label,
  size = 200,
}: {
  value: string
  label: string
  size?: number
}) {
  const { data, size: modules } = encode(value, { ecc: 'M', border: 2 })
  const cells: string[] = []
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) cells.push(`M${x} ${y}h1v1h-1z`)
    })
  })
  return (
    <svg
      className="qr"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${modules} ${modules}`}
      width={size}
      height={size}
    >
      <rect width={modules} height={modules} fill="#ffffff" />
      <path d={cells.join('')} fill="#000000" />
    </svg>
  )
}
