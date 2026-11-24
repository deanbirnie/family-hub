/**
 * A small PDF writer, made for the hub's health reports (phase 5d). It runs
 * on the device (browser or Android app) with no libraries: A4 pages, the
 * standard Helvetica fonts (built into every PDF reader, so nothing is
 * embedded), wrapped text, tables that break across pages, lines, boxes and
 * simple line charts.
 *
 * Text is encoded as WinAnsi (Latin-1 plus curly quotes and dashes), which
 * covers English and Afrikaans. Anything else is replaced, never dropped
 * silently: accents are stripped and other characters become "?".
 */

export type Rgb = [number, number, number]

export const A4 = { width: 595.28, height: 841.89 }

// Helvetica and Helvetica-Bold advance widths (1/1000 em) for ASCII 32–126, from the standard font metrics.
// prettier-ignore
const HELVETICA = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584]
// prettier-ignore
const HELVETICA_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584]

/** Unicode characters that WinAnsi has outside Latin-1, and their codes. */
const WIN_ANSI: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
}

/** Characters with a plain stand-in. */
const STAND_IN: Record<string, string> = { 'Ł': 'L', 'ł': 'l', 'Đ': 'D', 'đ': 'd', '→': '->', '←': '<-', '≤': '<=', '≥': '>=', '−': '-', '₂': '2', '₁': '1', '✓': 'v', ' ': ' ', ' ': ' ', ' ': ' ' }

/** WinAnsi bytes for a string: one byte per character. */
export function encodeText(text: string): number[] {
  const out: number[] = []
  for (const ch of text.replace(/[\t\r\n]+/g, ' ')) {
    const code = ch.codePointAt(0)!
    if (code >= 32 && code < 127) out.push(code)
    else if (code >= 160 && code <= 255) out.push(code)
    else if (WIN_ANSI[ch] !== undefined) out.push(WIN_ANSI[ch]!)
    else if (STAND_IN[ch] !== undefined) out.push(...encodeText(STAND_IN[ch]!))
    else {
      const plain = ch.normalize('NFD').replace(/[̀-ͯ]/g, '')
      if (plain !== ch && plain.length > 0) out.push(...encodeText(plain))
      else out.push(63) // "?"
    }
  }
  return out
}

/** Width of a string in points. */
export function textWidth(text: string, size: number, bold = false): number {
  const table = bold ? HELVETICA_BOLD : HELVETICA
  let w = 0
  for (const b of encodeText(text)) w += b >= 32 && b < 127 ? table[b - 32]! : 556
  return (w * size) / 1000
}

/** Splits text into lines no wider than `width` (breaking long words if need be). Keeps blank lines. */
export function wrapText(text: string, width: number, size: number, bold = false): string[] {
  const lines: string[] = []
  for (const para of text.split(/\r?\n/)) {
    let line = ''
    for (const word of para.split(/ +/)) {
      if (!word) continue
      const candidate = line ? `${line} ${word}` : word
      if (textWidth(candidate, size, bold) <= width) {
        line = candidate
        continue
      }
      if (line) lines.push(line)
      // A word too long for a whole line is broken where it must be.
      let rest = word
      while (textWidth(rest, size, bold) > width) {
        let n = rest.length - 1
        while (n > 1 && textWidth(rest.slice(0, n), size, bold) > width) n--
        lines.push(rest.slice(0, n))
        rest = rest.slice(n)
      }
      line = rest
    }
    lines.push(line)
  }
  return lines
}

const num = (n: number) => (Math.round(n * 100) / 100).toString()
const colour = (c: Rgb) => c.map((v) => num(v)).join(' ')

/** A PDF string literal: printable ASCII as is, everything else as octal escapes. */
function literal(text: string): string {
  let out = '('
  for (const b of encodeText(text)) {
    if (b === 40 || b === 41 || b === 92) out += `\\${String.fromCharCode(b)}`
    else if (b >= 32 && b < 127) out += String.fromCharCode(b)
    else out += `\\${b.toString(8).padStart(3, '0')}`
  }
  return `${out})`
}

/** A low-level document: pages of drawing operations, written out as a PDF. Coordinates are from the top left, in points. */
export class PdfDocument {
  readonly pages: string[][] = []
  private info: { title: string; author?: string }

  constructor(info: { title: string; author?: string }) {
    this.info = info
  }

  addPage(): number {
    this.pages.push([])
    return this.pages.length - 1
  }

  private op(page: number, s: string) {
    this.pages[page]!.push(s)
  }

  text(page: number, x: number, y: number, text: string, opts: { size?: number; bold?: boolean; color?: Rgb; align?: 'left' | 'right' | 'center' } = {}) {
    const size = opts.size ?? 10
    const w = opts.align && opts.align !== 'left' ? textWidth(text, size, opts.bold) : 0
    const left = opts.align === 'right' ? x - w : opts.align === 'center' ? x - w / 2 : x
    // PDF's origin is the bottom left; the baseline sits about 0.8 em below the top of the line.
    this.op(page, `BT /${opts.bold ? 'F2' : 'F1'} ${num(size)} Tf ${colour(opts.color ?? [0.1, 0.1, 0.12])} rg ${num(left)} ${num(A4.height - y - size * 0.8)} Td ${literal(text)} Tj ET`)
  }

  line(page: number, x1: number, y1: number, x2: number, y2: number, opts: { width?: number; color?: Rgb } = {}) {
    this.op(page, `${num(opts.width ?? 0.5)} w ${colour(opts.color ?? [0.75, 0.75, 0.78])} RG ${num(x1)} ${num(A4.height - y1)} m ${num(x2)} ${num(A4.height - y2)} l S`)
  }

  polyline(page: number, points: [number, number][], opts: { width?: number; color?: Rgb } = {}) {
    if (points.length < 2) return
    const path = points.map(([x, y], i) => `${num(x)} ${num(A4.height - y)} ${i === 0 ? 'm' : 'l'}`).join(' ')
    this.op(page, `${num(opts.width ?? 1.5)} w 1 J 1 j ${colour(opts.color ?? [0.13, 0.4, 0.55])} RG ${path} S`)
  }

  rect(page: number, x: number, y: number, w: number, h: number, opts: { fill?: Rgb; stroke?: Rgb; width?: number } = {}) {
    const box = `${num(x)} ${num(A4.height - y - h)} ${num(w)} ${num(h)} re`
    if (opts.fill && opts.stroke) this.op(page, `${colour(opts.fill)} rg ${num(opts.width ?? 0.5)} w ${colour(opts.stroke)} RG ${box} B`)
    else if (opts.fill) this.op(page, `${colour(opts.fill)} rg ${box} f`)
    else this.op(page, `${num(opts.width ?? 0.5)} w ${colour(opts.stroke ?? [0.75, 0.75, 0.78])} RG ${box} S`)
  }

  /** A filled circle (four Bézier curves). */
  dot(page: number, cx: number, cy: number, r: number, fill: Rgb) {
    const k = 0.5523 * r
    const y = A4.height - cy
    this.op(
      page,
      `${colour(fill)} rg ${num(cx + r)} ${num(y)} m ${num(cx + r)} ${num(y + k)} ${num(cx + k)} ${num(y + r)} ${num(cx)} ${num(y + r)} c ` +
        `${num(cx - k)} ${num(y + r)} ${num(cx - r)} ${num(y + k)} ${num(cx - r)} ${num(y)} c ${num(cx - r)} ${num(y - k)} ${num(cx - k)} ${num(y - r)} ${num(cx)} ${num(y - r)} c ` +
        `${num(cx + k)} ${num(y - r)} ${num(cx + r)} ${num(y - k)} ${num(cx + r)} ${num(y)} c f`,
    )
  }

  /** The finished file. */
  toBytes(): Uint8Array {
    const objects: string[] = []
    const add = (body: string) => objects.push(body) // object number = index + 1
    add('') // 1: catalog (filled in below)
    add('') // 2: pages
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>') // 3
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>') // 4
    const kids: number[] = []
    for (const ops of this.pages) {
      const content = ops.join('\n')
      add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
      const contentId = objects.length
      add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(A4.width)} ${num(A4.height)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`)
      kids.push(objects.length)
    }
    objects[0] = '<< /Type /Catalog /Pages 2 0 R >>'
    objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`
    add(`<< /Title ${literal(this.info.title)}${this.info.author ? ` /Author ${literal(this.info.author)}` : ''} /Producer (Family Hub) >>`)
    const infoId = objects.length

    // Everything is ASCII, so string length is byte length.
    let out = '%PDF-1.4\n%âãÏÓ\n'
    const offsets: number[] = []
    objects.forEach((body, i) => {
      offsets.push(out.length)
      out += `${i + 1} 0 obj\n${body}\nendobj\n`
    })
    const xref = out.length
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    const bytes = new Uint8Array(out.length)
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff
    return bytes
  }
}

// ---- flowing layout ----------------------------------------------------------------------------

const INK: Rgb = [0.1, 0.1, 0.12]
const MUTED: Rgb = [0.4, 0.4, 0.45]
const RULE: Rgb = [0.82, 0.82, 0.85]
export const ACCENT: Rgb = [0.13, 0.4, 0.55]
export const WARN: Rgb = [0.7, 0.15, 0.1]
const WARN_SOFT: Rgb = [0.99, 0.93, 0.92]
const SHADE: Rgb = [0.95, 0.95, 0.96]

export interface Column {
  title: string
  /** Share of the width. */
  width: number
  bold?: boolean
}

/**
 * Lays out a report top to bottom, starting new pages as needed, with a
 * running header and "page n of N" on every page.
 */
export class Report {
  readonly doc: PdfDocument
  private page = -1
  y = 0
  readonly margin = 48
  readonly width = A4.width - 96
  private bottom = A4.height - 56
  private header: string

  constructor(info: { title: string; author?: string; header: string }) {
    this.doc = new PdfDocument(info)
    this.header = info.header
    this.newPage()
  }

  newPage() {
    this.page = this.doc.addPage()
    this.doc.text(this.page, this.margin, 24, this.header, { size: 8, color: MUTED })
    this.y = this.margin
  }

  /** Makes sure `height` points fit on this page, or starts a new one. */
  room(height: number) {
    if (this.y + height > this.bottom) this.newPage()
  }

  space(h = 8) {
    this.y += h
  }

  title(text: string, sub?: string) {
    for (const l of wrapText(text, this.width, 20, true)) {
      this.room(26)
      this.doc.text(this.page, this.margin, this.y, l, { size: 20, bold: true })
      this.y += 26
    }
    if (sub) this.paragraph(sub, { color: MUTED, size: 10 })
    this.space(6)
  }

  /** A section heading, kept on the same page as the first `keep` points of what follows it. */
  heading(text: string, keep = 48) {
    this.room(keep)
    this.space(8)
    this.doc.text(this.page, this.margin, this.y, text, { size: 13, bold: true, color: ACCENT })
    this.y += 17
    this.doc.line(this.page, this.margin, this.y, this.margin + this.width, this.y, { color: RULE })
    this.y += 7
  }

  subheading(text: string) {
    this.room(32)
    this.space(2)
    this.doc.text(this.page, this.margin, this.y, text, { size: 11, bold: true })
    this.y += 15
  }

  paragraph(text: string, opts: { size?: number; bold?: boolean; color?: Rgb; indent?: number } = {}) {
    const size = opts.size ?? 10
    const indent = opts.indent ?? 0
    for (const l of wrapText(text, this.width - indent, size, opts.bold)) {
      this.room(size * 1.4)
      if (l) this.doc.text(this.page, this.margin + indent, this.y, l, { size, bold: opts.bold, color: opts.color ?? INK })
      this.y += size * 1.4
    }
  }

  /** "Label: value" rows, the labels in a column. */
  facts(rows: [string, string][], labelWidth = 130) {
    for (const [label, value] of rows) {
      if (!value) continue
      const lines = wrapText(value, this.width - labelWidth, 10)
      this.room(lines.length * 14)
      this.doc.text(this.page, this.margin, this.y, label, { size: 10, color: MUTED })
      for (const l of lines) {
        this.doc.text(this.page, this.margin + labelWidth, this.y, l, { size: 10 })
        this.y += 14
      }
    }
  }

  bullets(items: string[], opts: { color?: Rgb; bold?: boolean } = {}) {
    for (const item of items) {
      const lines = wrapText(item, this.width - 14, 10, opts.bold)
      this.room(14)
      this.doc.text(this.page, this.margin + 2, this.y, '•', { size: 10, color: opts.color ?? ACCENT })
      for (const l of lines) {
        this.room(14)
        this.doc.text(this.page, this.margin + 14, this.y, l, { size: 10, bold: opts.bold, color: opts.color ?? INK })
        this.y += 14
      }
    }
  }

  muted(text: string) {
    this.paragraph(text, { color: MUTED, size: 9 })
  }

  /** A shaded box that stands out, for severe allergies. */
  alert(title: string, lines: string[]) {
    const body = lines.flatMap((l) => wrapText(l, this.width - 20, 10, true))
    const h = 26 + body.length * 14
    this.room(h + 6)
    this.doc.rect(this.doc.pages.length - 1, this.margin, this.y, this.width, h, { fill: WARN_SOFT, stroke: WARN, width: 1 })
    this.doc.text(this.page, this.margin + 10, this.y + 8, title, { size: 11, bold: true, color: WARN })
    let y = this.y + 24
    for (const l of body) {
      this.doc.text(this.page, this.margin + 10, y, l, { size: 10, bold: true, color: WARN })
      y += 14
    }
    this.y += h + 8
  }

  /** A table with a header row repeated on each page; cells wrap. */
  table(columns: Column[], rows: string[][], opts: { highlight?: (row: number) => boolean } = {}) {
    const total = columns.reduce((s, c) => s + c.width, 0)
    const widths = columns.map((c) => (c.width / total) * this.width)
    const pad = 4
    const headerRow = () => {
      const lines = columns.map((c, i) => wrapText(c.title, widths[i]! - pad * 2, 9, true))
      const h = Math.max(...lines.map((l) => l.length)) * 12 + pad * 2
      this.doc.rect(this.page, this.margin, this.y, this.width, h, { fill: SHADE })
      let x = this.margin
      columns.forEach((_, i) => {
        lines[i]!.forEach((l, j) => this.doc.text(this.page, x + pad, this.y + pad + j * 12, l, { size: 9, bold: true }))
        x += widths[i]!
      })
      this.y += h
    }
    this.room(40)
    headerRow()
    rows.forEach((row, r) => {
      const lines = row.map((cell, i) => wrapText(cell ?? '', widths[i]! - pad * 2, 9, columns[i]!.bold))
      const h = Math.max(1, ...lines.map((l) => l.length)) * 12 + pad * 2
      if (this.y + h > this.bottom) {
        this.newPage()
        headerRow()
      }
      if (opts.highlight?.(r)) this.doc.rect(this.page, this.margin, this.y, this.width, h, { fill: WARN_SOFT })
      let x = this.margin
      row.forEach((_, i) => {
        lines[i]!.forEach((l, j) => this.doc.text(this.page, x + pad, this.y + pad + j * 12, l, { size: 9, bold: columns[i]!.bold, color: opts.highlight?.(r) ? WARN : INK }))
        x += widths[i]!
      })
      this.y += h
      this.doc.line(this.page, this.margin, this.y, this.margin + this.width, this.y, { color: RULE })
    })
    this.space(8)
  }

  /** A line chart of values over time, with the lowest, highest and a reference line (e.g. 38 °C). */
  chart(title: string, unit: string, points: { at: number; value: number }[], opts: { reference?: number; label: (at: number) => string }) {
    if (points.length === 0) return
    const h = 130
    this.room(h + 30)
    this.subheading(`${title} (${unit})`)
    const left = this.margin + 34
    const right = this.margin + this.width - 8
    const top = this.y + 6
    const plotH = h - 34
    const values = points.map((p) => p.value).concat(opts.reference !== undefined ? [opts.reference] : [])
    let lo = Math.min(...values)
    let hi = Math.max(...values)
    if (hi - lo < 1) {
      lo -= 0.5
      hi += 0.5
    }
    const span = hi - lo
    lo -= span * 0.08
    hi += span * 0.08
    const t0 = points[0]!.at
    const t1 = points[points.length - 1]!.at
    const x = (t: number) => (t1 === t0 ? (left + right) / 2 : left + ((t - t0) / (t1 - t0)) * (right - left))
    const y = (v: number) => top + (1 - (v - lo) / (hi - lo)) * plotH
    // Grid: lowest and highest readings.
    const minV = Math.min(...points.map((p) => p.value))
    const maxV = Math.max(...points.map((p) => p.value))
    for (const v of [...new Set([minV, maxV])]) {
      this.doc.line(this.page, left, y(v), right, y(v), { color: RULE })
      this.doc.text(this.page, left - 4, y(v) - 4, num(v), { size: 8, color: MUTED, align: 'right' })
    }
    if (opts.reference !== undefined) {
      this.doc.line(this.page, left, y(opts.reference), right, y(opts.reference), { color: [0.9, 0.6, 0.55], width: 0.8 })
      this.doc.text(this.page, right, y(opts.reference) - 10, `${num(opts.reference)} ${unit}`, { size: 7, color: WARN, align: 'right' })
    }
    this.doc.line(this.page, left, top + plotH, right, top + plotH, { color: MUTED })
    this.doc.polyline(
      this.page,
      points.map((p) => [x(p.at), y(p.value)]),
      { color: ACCENT },
    )
    for (const p of points) this.doc.dot(this.page, x(p.at), y(p.value), 2.2, ACCENT)
    this.doc.text(this.page, left, top + plotH + 6, opts.label(t0), { size: 8, color: MUTED })
    if (t1 !== t0) this.doc.text(this.page, right, top + plotH + 6, opts.label(t1), { size: 8, color: MUTED, align: 'right' })
    this.y = top + plotH + 24
  }

  /** The finished PDF, with page numbers. */
  finish(footer: string): Uint8Array {
    const n = this.doc.pages.length
    for (let i = 0; i < n; i++) {
      this.doc.text(i, this.margin, A4.height - 36, footer, { size: 8, color: MUTED })
      this.doc.text(i, A4.width - this.margin, A4.height - 36, `Page ${i + 1} of ${n}`, { size: 8, color: MUTED, align: 'right' })
    }
    return this.doc.toBytes()
  }
}
