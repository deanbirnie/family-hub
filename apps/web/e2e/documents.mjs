/** Real PDF/image previews and organisation, exercised by both app shells. */
export function examplePdf() {
  const stream = (text) => { const body = `BT /F1 18 Tf 24 150 Td (${text}) Tj ET`; return `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream` }
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', stream('Family reference page one'), stream('Family reference page two')]
  let pdf = '%PDF-1.4\n', offsets = [0]
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${body}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

export async function documentChecks(page, shot = async () => {}) {
  await page.getByRole('button', { name: 'New folder', exact: true }).click()
  await page.getByLabel('Name', { exact: true }).fill('Insurance')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Insurance', exact: true }).click()
  await page.getByRole('heading', { name: 'No documents yet' }).waitFor()
  await page.getByLabel('Choose documents').setInputFiles([
    { name: 'reference.pdf', mimeType: 'application/pdf', buffer: examplePdf() },
    { name: 'scan.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBZkAAAAASUVORK5CYII=', 'base64') },
  ])
  await page.getByText('2 documents uploaded.').waitFor()
  await page.getByRole('button', { name: 'reference.pdf', exact: true }).click()
  await page.locator('canvas.pdf-page').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Next page' }).click()
  await page.getByText('Page 2 of 2', { exact: true }).waitFor()
  await page.locator('canvas.pdf-page').waitFor({ state: 'visible' })
  await page.getByText('Family reference page two', { exact: true }).waitFor({ state: 'attached' })
  await shot('pdf-preview')
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'scan.png', exact: true }).click()
  await page.getByRole('img', { name: 'scan.png', exact: true }).waitFor()
  if (!(await page.getByRole('img', { name: 'scan.png', exact: true }).evaluate((img) => img.complete && img.naturalWidth > 0))) {
    await page.getByRole('img', { name: 'scan.png', exact: true }).evaluate((img) => img.decode())
  }
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Rename scan.png', exact: true }).click()
  await page.getByLabel('Name', { exact: true }).fill('receipt.png')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Move receipt.png', exact: true }).click()
  await page.getByRole('button', { name: 'Move here', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByLabel('Search documents', { exact: true }).fill('receipt')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await page.getByRole('button', { name: 'receipt.png', exact: true }).waitFor()
  await page.getByRole('navigation', { name: 'Folder path' }).getByRole('button', { name: 'Family', exact: true }).click()
  await page.getByRole('button', { name: 'Insurance', exact: true }).waitFor()
  await shot('documents')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)
  if (overflow) throw new Error('the document page overflows horizontally')
}
