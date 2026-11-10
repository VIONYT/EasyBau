// Brief nach DIN 5008 Form B, A4 (OpenPlancraft). All content comes from /data.json and is
// rendered as plain text (never evaluated as markup). Positions in mm, see DIN5008B in
// packages/domain/src/letterhead.ts.

#let data = json("/data.json")
#let accent = rgb(data.accent)
#let muted = rgb("#4b5563")
#let font = if data.font == "serif" { "DejaVu Serif" } else { "Inter" }
#let lines(s) = s.split("\n").join(linebreak())
#let alignment-of(a) = if a == "right" { right } else if a == "center" { center } else { left }

#set document(title: data.title, author: data.author)
// E-Rechnung: the XML is attached as associated file (PDF/A-3, ZUGFeRD/Factur-X: factur-x.xml).
#let attachment = data.at("attachment", default: none)
#if attachment != none {
  pdf.attach(
    attachment.path,
    relationship: "alternative",
    mime-type: "text/xml",
    description: attachment.description,
  )
}
#set text(font: font, size: 10pt, lang: "de", region: "DE", fill: rgb("#111827"))
#set par(leading: 0.5em, spacing: 0.9em)

// ---- Page 1: Briefkopf, Anschriftfeld, Informationsblock, Falzmarken -------------------------
#let first-page = {
  if data.logo != none {
    place(top + left, dx: data.logo.x * 1mm, dy: data.logo.y * 1mm, context {
      let wide = image(data.logo.path, width: data.logo.width * 1mm)
      if measure(wide).height > data.logo.maxHeight * 1mm {
        image(data.logo.path, height: data.logo.maxHeight * 1mm)
      } else { wide }
    })
  }
  for t in data.texts {
    place(top + left, dx: t.x * 1mm, dy: t.y * 1mm, block(width: t.width * 1mm, align(
      alignment-of(t.align),
      text(
        size: t.fontSize * 1pt,
        weight: if t.bold { "bold" } else { "regular" },
        fill: rgb(t.color),
        lines(t.text),
      ),
    )))
  }
  // Anschriftfeld: 85 × 45 mm at 20/45 mm, text inset 5 mm; Rücksendeangabe at the bottom of
  // the 17.7 mm Zusatz- und Vermerkzone.
  place(top + left, dx: 25mm, dy: 45mm, block(width: 80mm, height: 45mm, {
    block(height: 17.7mm, width: 100%, align(bottom, text(size: 7pt, fill: muted, underline(
      data.senderLine,
    ))))
    v(1.5mm, weak: true)
    for l in data.recipient { [#l #linebreak()] }
  }))
  place(top + left, dx: 125mm, dy: 50mm, block(width: 75mm, text(size: 9pt, grid(
    columns: (30mm, 1fr),
    row-gutter: 1.2mm,
    column-gutter: 2mm,
    ..data.info.map(row => (text(fill: muted, row.label), row.value)).flatten(),
  ))))
  if data.foldMarks {
    for y in (105mm, 210mm) { place(top + left, dx: 4mm, dy: y, line(length: 5mm, stroke: 0.2mm + luma(150))) }
    place(top + left, dx: 4mm, dy: 148.5mm, line(length: 8mm, stroke: 0.2mm + luma(150)))
  }
}

// ---- Every page: footer and watermark ------------------------------------------------------
#let footer = place(top + left, dx: 25mm, dy: 272mm, block(width: 165mm, {
  line(length: 100%, stroke: 0.3mm + accent)
  v(2mm, weak: true)
  if data.footer.len() > 0 {
    text(size: 7pt, fill: rgb("#374151"), grid(
      columns: (1fr,) * data.footer.len(),
      column-gutter: 4mm,
      ..data.footer.map(lines),
    ))
  }
}))

#let watermark = if data.watermark != none {
  place(center + horizon, rotate(-20deg, text(
    size: 60pt,
    weight: "bold",
    fill: rgb(185, 28, 28, 30),
    data.watermark,
  )))
}

#set page(
  paper: "a4",
  margin: (top: 18mm, bottom: 34mm, left: 25mm, right: 20mm),
  background: context {
    if counter(page).get().first() == 1 { first-page }
    footer
    watermark
  },
)

// ---- Text ------------------------------------------------------------------------------------
// Page 1: the text starts at 98.46 mm (DIN 5008 Form B).
#v(98.46mm - 18mm)

#text(size: 14pt, weight: "bold", fill: accent, data.body.heading)
#if data.body.subject != none { block(above: 2mm, text(weight: "bold", data.body.subject)) }
#for s in data.body.small { block(above: 1.5mm, text(size: 9pt, fill: muted, s)) }
#if data.body.intro != none { block(above: 4mm, lines(data.body.intro)) }

#let cell-stroke = (bottom: 0.5pt + luma(225))

// ---- Building blocks (Aufmaßblatt, Berichte) ---------------------------------------------------
#let align-of(a) = if a == "right" { right + top } else if a == "center" { center + top } else { left + top }
#let width-of(w) = if w == "auto" { auto } else if w == "1fr" { 1fr } else { float(w) * 1mm }
#for b in data.body.blocks {
  if b.kind == "heading" {
    block(above: 5mm, below: 2mm, sticky: true, text(size: 11pt, weight: "bold", fill: accent, b.text))
  } else if b.kind == "text" {
    block(above: 2mm, lines(b.text))
  } else if b.kind == "facts" {
    block(above: 2mm, grid(
      columns: (45mm, 1fr),
      row-gutter: 1.5mm,
      column-gutter: 3mm,
      ..b.rows.map(r => (text(fill: muted, r.label), lines(r.value))).flatten(),
    ))
  } else if b.kind == "table" {
    let n = b.columns.len()
    let cells = ()
    for r in b.rows {
      if r.group {
        cells.push(table.cell(colspan: n, fill: luma(243), strong(r.cells.first())))
      } else {
        for c in r.cells { cells.push(if r.strong { strong(c) } else { c }) }
      }
    }
    block(above: 2mm, text(size: 9pt, table(
      columns: b.widths.map(width-of),
      inset: (x: 1.2mm, y: 1.1mm),
      stroke: (x, y) => if y == 0 { (bottom: 1.2pt + accent) } else { cell-stroke },
      align: (x, y) => align-of(b.align.at(x)),
      table.header(..b.columns.map(c => text(weight: "bold", fill: accent, c))),
      ..cells,
    )))
  } else if b.kind == "images" {
    block(above: 2mm, grid(
      columns: (1fr, 1fr),
      column-gutter: 4mm,
      row-gutter: 4mm,
      ..b.items.map(i => block(breakable: false, {
        box(width: 100%, height: 60mm, image(i.path, width: 100%, height: 100%, fit: "contain"))
        if i.caption != none { block(above: 1mm, text(size: 8.5pt, fill: muted, i.caption)) }
      })),
    ))
  } else if b.kind == "signatures" {
    block(above: 8mm, breakable: false, grid(
      columns: (1fr,) * calc.max(b.items.len(), 2),
      column-gutter: 10mm,
      ..b.items.map(s => {
        let image-path = s.at("image", default: none)
        // Same height with or without a handwritten signature, so the lines stay aligned.
        block(height: 16mm, width: 100%, below: 0.6mm,
          if image-path != none { image(image-path, width: 100%, height: 100%, fit: "contain") })
        line(length: 100%, stroke: 0.5pt)
        text(size: 8.5pt, [#s.label: #s.name])
        if s.date != none { linebreak() + text(size: 8.5pt, fill: muted, s.date) }
      }),
    ))
  }
}

#if data.body.items.len() > 0 {
  set text(size: 9pt)
  let rows = ()
  for item in data.body.items {
    if item.kind == "title" {
      rows += (
        table.cell(fill: luma(243), item.oz),
        table.cell(colspan: 3, fill: luma(243), strong(item.text)),
        table.cell(fill: luma(243), strong(item.total)),
      )
    } else if item.kind == "text" {
      rows += ([], table.cell(colspan: 4, lines(item.text)))
    } else {
      let description = {
        item.text
        if item.note != none { text(style: "italic", [ (#item.note)]) }
        if item.longText != none { block(above: 1mm, text(size: 8.5pt, fill: muted, lines(item.longText))) }
      }
      rows += (item.oz, description, item.quantity, item.unitPrice, item.total)
    }
  }
  block(above: 4mm, table(
    columns: (auto, 1fr, auto, auto, auto),
    inset: (x: 1.2mm, y: 1.2mm),
    stroke: (x, y) => if y == 0 { (bottom: 1.5pt + accent) } else { cell-stroke },
    align: (x, y) => if x >= 2 { right + top } else { left + top },
    table.header(..data.body.columns.map(c => text(weight: "bold", fill: accent, c))),
    ..rows,
  ))
}

// Abschlagsaufstellung (§ 14 Abs. 5 UStG)
#if data.body.deductions != none {
  let d = data.body.deductions
  block(above: 4mm, breakable: false, {
    text(weight: "bold", d.title)
    set text(size: 9pt)
    table(
      columns: (1fr, auto, auto, auto),
      inset: (x: 1.2mm, y: 1mm),
      stroke: (x, y) => if y == 0 { (bottom: 1pt + accent) } else { cell-stroke },
      align: (x, y) => if x > 0 { right } else { left },
      table.header(..d.columns.map(c => text(weight: "bold", c))),
      ..d.rows.map(r => (r.label, r.net, r.tax, r.gross)).flatten(),
      ..(strong(d.rest.label), strong(d.rest.net), strong(d.rest.tax), strong(d.rest.gross)),
    )
  })
}

#if data.body.totals.len() > 0 { align(right, block(width: 95mm, above: 4mm, breakable: false, table(
  columns: (1fr, auto),
  stroke: none,
  inset: (x: 0pt, y: 1.3mm),
  column-gutter: 4mm,
  align: (x, y) => if x == 0 { left } else { right },
  ..data.body.totals
    .map(row => {
      let cells = ()
      if row.grand { cells.push(table.hline(stroke: 1.2pt + rgb("#111827"))) }
      cells.push(if row.grand { strong(row.label) } else { row.label })
      cells.push(if row.grand { strong(row.value) } else { row.value })
      if row.note != none {
        cells.push(table.cell(colspan: 2, text(size: 8pt, fill: muted, row.note)))
      }
      cells
    })
    .flatten(),
))) }

#for note in data.body.notes { block(above: 3mm, text(size: 9.5pt, note)) }
#if data.body.closing != none { block(above: 4mm, lines(data.body.closing)) }
